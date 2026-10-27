import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DATA_DIR } from './config.ts';
import type { CerebroDatabase, Project } from './db.ts';
import { rememberWorktree } from './worktrees.ts';
import { canonicalWorktreePath } from './worktree-gate.ts';
import { prepareCommit, type GitSnapshot } from './git-plan.ts';
import { workspaceFileSignature } from './workspace-files.ts';
import { execGit } from './git-process.ts';
const git = async (path: string, args: string[], index?: string): Promise<string> => (await execGit(['-C', path, ...args], {
  env: {GIT_OPTIONAL_LOCKS: '0', ...(index ? {GIT_INDEX_FILE:index} : {})},
})).toString('utf8').trim();
export interface WorkspaceContext { mode: 'isolated' | 'shared' | 'unknown'; path: string }
export interface Workspace {
  sessionId: string;
  projectId?: string;
  projectName?: string;
  projectRoot?: string;
  targetBranch?: string | null;
  removedAt?: number;
  /** The copy was removed by the automatic cleanup at the end of the conversation, not by an explicit action. */
  removedAutomatically?: boolean;
  mode: 'isolated' | 'shared' | 'unknown';
  path: string;
  root: string;
  source: string;
  base: string | null;
  branch: string | null;
  initialDirty: string[];
  baseline: Record<string, string>;
  /** Directory, outside the repository, holding the files that were already modified in the project when the copy was created. */
  startingCopy?: string;
  /** Legacy: commit (under refs/cerebro/starting/) that held that content before it was kept out of Git. */
  startingSnapshot?: string;
  sharedIgnored?: string[];
  reason: string;
  createdAt: number;
}
export interface Provenance {
  workspace: Workspace;
  changes: { path: string; certainty: 'workspace' | 'uncertain'; reason: string }[];
  commits: { hash: string; title: string; certainty: 'workspace' | 'uncertain' }[];
  warning: string;
}
export function workspaceFor(db: CerebroDatabase, id: string): Workspace | null {
  const row = db.connection.prepare('SELECT data FROM session_workspaces WHERE session_id=?').get(id) as {data:string} | undefined;
  return row ? JSON.parse(row.data) as Workspace : null;
}
function save(db: CerebroDatabase, workspace: Workspace): Workspace {
  db.connection.prepare('INSERT INTO session_workspaces (session_id, data) VALUES (?,?)').run(workspace.sessionId,JSON.stringify(workspace));
  return workspace;
}
async function manifest(path: string,excluded:string[]=[]): Promise<Record<string,string>> {
  const entries: [string,string][] = [];
  const names=(await git(path,['ls-files','--cached','--others','--exclude-standard','-z'])).split('\0').filter(Boolean)
    .filter(name=>!excluded.some(prefix=>name===prefix||name.startsWith(`${prefix}/`))).sort();
  for(const name of names){
    const signature=await workspaceFileSignature(join(path,name));
    entries.push([name,signature??'missing']);
  }
  return Object.fromEntries(entries);
}
const signature = (m: Record<string,string>): string => JSON.stringify(m);
function firstDifference(a:Record<string,string>,b:Record<string,string>):string{
  for(const name of new Set([...Object.keys(a),...Object.keys(b)]))if(a[name]!==b[name])return name;
  return 'inconnue';
}
/** Where the content copied from the project at the creation of `sessionId`'s copy is kept. */
export const startingCopyDirectory = (sessionId: string): string => join(DATA_DIR, 'starting', sessionId);
/**
 * Keeps the content copied from the project, so it can still be separated from the conversation's
 * work once the project has changed. Best effort: a copy without it only loses that separation.
 * Plain files outside the repository, never Git objects: untracked files (.env, keys, dumps) would
 * otherwise stay in the shared object database, reachable by a ref and pushed by a mirror.
 */
async function snapshotStartingContent(workspace:string,sessionId:string,paths:string[]):Promise<string|undefined>{
  if(!paths.length)return undefined;
  const target=startingCopyDirectory(sessionId);
  try{
    await rm(target,{recursive:true,force:true});
    await mkdir(target,{recursive:true,mode:0o700});
    for(const path of paths){
      // Deleted files and links have no content to restore: their baseline signature is never looked up.
      if(!(await lstat(join(workspace,path)).catch(()=>null))?.isFile())continue;
      await mkdir(dirname(join(target,path)),{recursive:true});
      await copyFile(join(workspace,path),join(target,path));
    }
    return target;
  }catch{await rm(target,{recursive:true,force:true});return undefined;}
}
const SHARED_DEPENDENCY_DIRS = new Set(['node_modules','.venv','venv','vendor']);

async function copyEntry(sourceRoot:string,targetRoot:string,name:string):Promise<void>{
  const source=join(sourceRoot,name);const target=join(targetRoot,name);
  await rm(target,{recursive:true,force:true});
  try{
    await mkdir(dirname(target),{recursive:true});
    await cp(source,target,{recursive:true,dereference:false,verbatimSymlinks:true});
  }catch(cause){if((cause as NodeJS.ErrnoException).code!=='ENOENT')throw cause;}
}

async function copyIgnoredContext(sourceRoot:string,targetRoot:string):Promise<string[]>{
  const ignored=(await git(sourceRoot,['ls-files','--others','--ignored','--exclude-standard','--directory','-z'])).split('\0').filter(Boolean);
  const shared:string[]=[];
  for(const raw of ignored){
    const name=raw.replace(/\/$/,'');
    if(!name)continue;
    const source=join(sourceRoot,name);const target=join(targetRoot,name);
    const stat=await lstat(source).catch(cause=>{if((cause as NodeJS.ErrnoException).code==='ENOENT')return null;throw cause;});
    if(!stat)continue;
    if(stat.isDirectory()){
      if(SHARED_DEPENDENCY_DIRS.has(basename(name))){
        await mkdir(dirname(target),{recursive:true});await rm(target,{recursive:true,force:true});await symlink(source,target,'dir');shared.push(name);
      }
      // Other ignored directories are normally generated output or caches. Copying an
      // unbounded tree here would recreate the startup problem this path is avoiding.
      continue;
    }
    await copyEntry(sourceRoot,targetRoot,name);
  }
  return shared;
}

/** Isolation is persisted before launching the holder. Historical sessions keep their cwd. */
export async function createWorkspace(db: CerebroDatabase, sessionId: string, project: Project): Promise<Workspace> {
  const registeredProject=db.getProject(project.id)??project;
  if(registeredProject.workspaceMode==='shared') {
    const root=await git(registeredProject.path,['rev-parse','--show-toplevel']).catch(()=>registeredProject.path);
    return save(db,{sessionId,projectId:registeredProject.id,projectName:registeredProject.name,projectRoot:root,
      mode:'shared',path:registeredProject.path,root,source:root,base:null,branch:null,initialDirty:[],baseline:{},
      reason:'Dossier du projet choisi dans l’en-tête du projet : les conversations utilisent la branche courante, sans création de copie ni attribution individuelle des changements.',createdAt:Date.now()});
  }
  const common: Workspace = {sessionId,projectId:project.id,projectName:project.name,mode:'unknown',path:project.path,root:project.path,source:project.path,base:null,branch:null,initialDirty:[],baseline:{},reason:'Projet sans historique Git : sélection explicite nécessaire.',createdAt:Date.now()};
  let root: string;
  try { root=await git(project.path,['rev-parse','--show-toplevel']); common.base=await git(root,['rev-parse','--verify','HEAD']); }
  catch { return save(db,common); }
  common.projectRoot=await git(registeredProject.path,['rev-parse','--show-toplevel']).catch(()=>root);
  common.targetBranch=await git(common.projectRoot,['symbolic-ref','--quiet','HEAD']).catch(()=>null);
  // Physical paths on both sides: a symlink must neither smuggle the data directory into the
  // repository nor move the session directory outside the copy.
  const dataDir=canonicalWorktreePath(DATA_DIR);const physicalRoot=canonicalWorktreePath(root);
  if (dataDir.startsWith(`${physicalRoot}/`) || dataDir===physicalRoot) throw new Error('Le dossier Cerebro doit être situé hors du dépôt pour isoler les sessions.');
  if ((await git(root,['ls-files','--stage'])).split('\n').some(line=>line.startsWith('160000 '))) throw new Error('Isolation des sous-modules non prise en charge : aucun agent lancé.');
  if (await git(root,['ls-files','-u'])) throw new Error('Résolvez les conflits de l’index avant de lancer une session isolée.');
  const before = await manifest(root);
  const indexPath=resolve(root,await git(root,['rev-parse','--git-path','index']));
  const indexBytes=await readFile(indexPath);
  const dirty=(await git(root,['diff','--name-only','-z','HEAD'])).split('\0').filter(Boolean);
  const staged=(await git(root,['diff','--cached','--name-only','-z'])).split('\0').filter(Boolean);
  const untracked=(await git(root,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
  const branch=`cerebro/session-${sessionId}`;
  const workspace=join(DATA_DIR,'workspaces',sessionId);
  await mkdir(join(DATA_DIR,'workspaces'),{recursive:true});
  const temporary=await mkdtemp(join(tmpdir(),'cerebro-isolate-'));
  let added=false;
  try {
    const sourceIndex=join(temporary,'source-index'); await writeFile(sourceIndex,indexBytes);
    const tree=await git(root,['write-tree'],sourceIndex);
    await git(root,['worktree','add','-b',branch,'--',workspace,common.base!]); added=true;
    // Recreate the indexed tree, then overlay only Git-visible local changes. Large dependency
    // directories are shared as links below instead of physically copying and hashing them.
    for (const name of await readdir(workspace)) if(name!=='.git') await rm(join(workspace,name),{recursive:true,force:true});
    await git(workspace,['read-tree',tree]);
    await git(workspace,['checkout-index','--all','--force']);
    for(const name of new Set([...dirty,...untracked]))await copyEntry(root,workspace,name);
    const sharedIgnored=await copyIgnoredContext(root,workspace);
    if (common.base!==await git(root,['rev-parse','HEAD']) || !indexBytes.equals(await readFile(indexPath)) || signature(before)!==signature(await manifest(root))) throw new Error('Le projet a changé pendant son isolation : relancez la session.');
    const baseline=await manifest(workspace,sharedIgnored);
    if(signature(before)!==signature(baseline)) throw new Error(`Copie initiale non identique (${firstDifference(before,baseline)}) : aucun agent lancé.`);
    const dependencyNotice=sharedIgnored.length?` Dépendances partagées avec le projet source : ${sharedIgnored.join(', ')}.`:'';
    const initialDirty=[...new Set([...dirty,...staged,...untracked])];
    const startingCopy=await snapshotStartingContent(workspace,sessionId,initialDirty);
    const saved=save(db,{...common,mode:'isolated',root:workspace,path:join(workspace,relative(physicalRoot,canonicalWorktreePath(project.path))),source:root,branch,baseline,...(startingCopy?{startingCopy}:{}),sharedIgnored,initialDirty,reason:`Périmètre de l’espace isolé ; les auteurs des éditions dans cet espace ne sont pas identifiables.${dependencyNotice}`});
    await rememberWorktree(db,saved);
    return saved;
  } catch(cause) {
    if(added) { await git(root,['worktree','remove','--force',workspace]).catch(()=>{}); await git(root,['branch','-D',branch]).catch(()=>{}); await rm(startingCopyDirectory(sessionId),{recursive:true,force:true}); }
    throw cause;
  } finally {await rm(temporary,{recursive:true,force:true});}
}

/** The live isolated copy whose session directory is `path`, if Cerebro created one there. */
export function workspaceAt(db: CerebroDatabase, path: string): Workspace | null {
  const target=canonicalWorktreePath(path);
  const rows=db.connection.prepare('SELECT data FROM session_workspaces').all() as {data:string}[];
  return rows.map(row=>JSON.parse(row.data) as Workspace)
    .filter(workspace=>workspace.mode==='isolated'&&!workspace.removedAt&&canonicalWorktreePath(workspace.path)===target)
    .sort((left,right)=>left.createdAt-right.createdAt)[0]??null;
}

/** Later epic steps work in the copy of the first one: one branch, one integration for the whole epic. */
export async function joinWorkspace(db: CerebroDatabase, sessionId: string, owner: Workspace): Promise<Workspace> {
  const excluded=owner.sharedIgnored??[];
  const inScope=(name:string):boolean=>!excluded.some(prefix=>name===prefix||name.startsWith(`${prefix}/`));
  const dirty=(await git(owner.root,['diff','--name-only','-z','HEAD'])).split('\0').filter(Boolean);
  const staged=(await git(owner.root,['diff','--cached','--name-only','-z'])).split('\0').filter(Boolean);
  const untracked=(await git(owner.root,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
  // Work left by previous steps is inherited, exactly like changes present in a project at copy creation.
  return save(db,{...owner,sessionId,baseline:await manifest(owner.root,excluded),initialDirty:[...new Set([...dirty,...staged,...untracked])].filter(inScope),
    reason:`${owner.reason} Copie partagée avec les étapes précédentes de l’epic.`,createdAt:Date.now()});
}

/** A started epic keeps its original location even when the project preference changes. */
export async function createWorkspaceInContext(db: CerebroDatabase, sessionId: string, project: Project, context: WorkspaceContext): Promise<Workspace> {
  if (context.mode === 'isolated') {
    const owner = workspaceAt(db, context.path);
    if (!owner || owner.projectId && owner.projectId !== project.id) throw new Error('Le worktree d’origine de l’epic est introuvable dans ce projet.');
    return joinWorkspace(db, sessionId, owner);
  }
  const root = await git(context.path, ['rev-parse', '--show-toplevel']).catch(() => context.path);
  return save(db, {sessionId, projectId:project.id, projectName:project.name, projectRoot:root,
    mode:context.mode, path:context.path, root, source:root, base:null, branch:null, initialDirty:[], baseline:{},
    reason:'Dossier d’origine de l’epic, conservé indépendamment du réglage des nouvelles conversations.', createdAt:Date.now()});
}

export function historicalWorkspace(sessionId: string, path: string): Workspace {
  return {sessionId,mode:'unknown',path,root:path,source:path,base:null,branch:null,initialDirty:[],baseline:{},reason:'Session historique sans provenance : sélection explicite nécessaire.',createdAt:0};
}

/**
 * Files touched by each commit, in a single Git run whatever the branch length: one process per
 * commit would spawn hundreds of them at once on a long branch. Merges are left out by diff-tree.
 */
async function pathsByCommit(root:string,oids:string[]):Promise<Map<string,string[]>>{
  const paths=new Map<string,string[]>();
  if(!oids.length)return paths;
  const expected=new Set(oids);let current:string[]|undefined;
  const output=(await execGit(['-C',root,'diff-tree','--stdin','-r','--name-only','-z'],{env:{GIT_OPTIONAL_LOCKS:'0'},input:`${oids.join('\n')}\n`})).toString('utf8');
  // Each commit header is its own NUL-terminated record, followed by the paths it changed.
  for(const token of output.split('\0')){
    if(!token)continue;
    if(expected.has(token)&&!paths.has(token)){current=[];paths.set(token,current);}
    else current?.push(token);
  }
  return paths;
}

export async function sessionProvenance(db: CerebroDatabase, sessionId: string): Promise<Provenance> {
  const session=db.getSession(sessionId);
  if(!session) throw new Error('Session introuvable.');
  const project=db.getProject(session.projectId)!;
  const workspace=workspaceFor(db,sessionId)??historicalWorkspace(sessionId,project.path);
  const warning='Le périmètre décrit un espace de travail, pas l’auteur des modifications. Toute édition humaine ou externe dans cet espace doit être vérifiée explicitement. Les changements initiaux ne sont pas attribués à la session.';
  if(workspace.mode!=='isolated') return {workspace,changes:[],commits:[],warning};
  const snapshot=await prepareCommit(workspace.root,workspace);
  const current=await manifest(workspace.root,workspace.sharedIgnored);
  const changed=snapshot.files.filter(f=>workspace.baseline[f.path]!==current[f.path]);
  const branchMatches = await git(workspace.root,['symbolic-ref','--short','HEAD']).then(branch => branch === workspace.branch, () => false);
  const reflog=await git(workspace.root,['reflog','show','--format=%gs',workspace.branch!]).catch(()=> '');
  const historyKnown=reflog.includes('branch: Created from')&&!reflog.split('\n').some(line=>line&&!/^(?:commit(?: \([^)]*\))?:|branch: Created from)/.test(line));
  const valid=branchMatches && historyKnown && await git(workspace.root,['merge-base','--is-ancestor',workspace.base!,'HEAD']).then(()=>true,()=>false);
  const records=valid?(await git(workspace.root,['log','--first-parent','--format=%H %P%x09%s',`${workspace.base}..HEAD`])).split('\n').filter(Boolean):[];
  const commitPaths=await pathsByCommit(workspace.root,records.map(line=>line.slice(0,line.indexOf(' '))));
  return {
    workspace:{...workspace,baseline:{}},warning: valid?warning:`${warning} L’historique de base a changé : attribution incertaine.`,
    changes:changed.map(f=>({path:f.path,certainty:valid&&!workspace.initialDirty.includes(f.path)&&!workspace.baseline[f.path]?.startsWith('link:')?'workspace':'uncertain',reason:workspace.initialDirty.includes(f.path)?'Fichier modifié avant la session : sélection manuelle des hunks nécessaire.':'Modification dans l’espace isolé ; auteur non garanti.'})),
    commits:records.map(line=>{
      const [ids,...title]=line.split('\t');
      const [oid,...parents]=ids.split(' ');
      const paths=commitPaths.get(oid)??[];
      return {hash:oid,title:title.join('\t'),certainty:parents.length!==1||paths.some(p=>workspace.initialDirty.includes(p))?'uncertain' as const:'workspace' as const};
    }),
  };
}

export async function prepareSessionCommit(db: CerebroDatabase, id: string): Promise<GitSnapshot & { provenance: Provenance }> {
  const provenance=await sessionProvenance(db,id);
  const snapshot=await prepareCommit(provenance.workspace.root,provenance.workspace);
  return {...snapshot,provenance};
}
