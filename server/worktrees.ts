import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { CerebroDatabase } from './db.ts';
import type { CommitSettings } from './db.ts';
import type { Workspace } from './provenance.ts';
import { currentPush } from './git-push.ts';
import { assertWorktreeAvailable, canonicalWorktreePath, lockWorktrees } from './worktree-gate.ts';
import { workspaceFileSignature } from './workspace-files.ts';

const exec = promisify(execFile);
async function git(path: string, args: string[]): Promise<string> {
  return (await exec('git', ['-C', path, ...args], {
    maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' },
  })).stdout;
}
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const within = (root: string, path: string): boolean => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !part.startsWith(sep); };
export class WorktreeError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 409) { super(message); this.statusCode = statusCode; }
}
export interface WorktreeRecord {
  id: string;
  commonDir: string;
  path: string;
  source: string;
  projectId: string | null;
  projectName: string;
  sessionId: string | null;
  sessionTitle: string | null;
  managed: boolean;
  expectedBranch: string | null;
  targetBranch: string | null;
  createdAt: number;
  removedAt: number | null;
  commitSettings?: CommitSettings;
}
export interface WorktreeOperation {
  id: string;
  worktreeId: string;
  kind: 'merge' | 'remove';
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  targetBranch: string | null;
  sourceHead: string | null;
  targetHead: string | null;
  resultHead: string | null;
  output: string;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}
interface RegisteredWorktree { path: string; head: string | null; branch: string | null; locked: boolean; prunable: boolean }
export interface WorktreeView extends WorktreeRecord {
  projectExists: boolean;
  session: { id: string; title: string; status: string } | null;
  primary: boolean;
  branch: string | null;
  head: string | null;
  dirty: number | null;
  files: string[];
  ignored: number | null;
  ignoredFiles: string[];
  ahead: number | null;
  behind: number | null;
  targetPath: string | null;
  targetHead: string | null;
  targets: { branch: string; path: string }[];
  integration: 'integrated' | 'pending' | 'unknown';
  mergeInProgress: boolean;
  activeSessions: { id: string; title: string; status: string }[];
  mergeBlockers: string[];
  removeBlockers: string[];
  fingerprint: string | null;
  error: string | null;
  operation: WorktreeOperation | null;
  changesSinceCreation: {count:number;files:string[];inheritedCount:number;needsReviewCount:number} | null;
}
export interface WorktreeInventory { worktrees: WorktreeView[]; errors: string[] }

function records(db: CerebroDatabase): WorktreeRecord[] {
  return (db.connection.prepare('SELECT data FROM worktree_inventory ORDER BY rowid').all() as {data: string}[]).map(row => JSON.parse(row.data));
}
function store(db: CerebroDatabase, record: WorktreeRecord): void {
  db.connection.prepare('INSERT INTO worktree_inventory VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(record.id, JSON.stringify(record));
}
const worktreeId = (common: string, path: string): string => hash(`${common}\0${path}`).slice(0, 32);
async function commonDirectory(path: string): Promise<string> {
  return realpath(resolve(path, (await git(path, ['rev-parse', '--git-common-dir'])).trim()));
}
/** Persist identity while the session/project still exist. No foreign key cascades this record. */
export async function rememberWorktree(db: CerebroDatabase, workspace: Workspace): Promise<void> {
  if (workspace.mode !== 'isolated') return;
  const commonDir = await commonDirectory(workspace.root).catch(()=>commonDirectory(workspace.projectRoot??workspace.source));
  const path = await realpath(workspace.root);
  const id = worktreeId(commonDir, path);
  if (records(db).some(record => record.id === id)) return;
  const session = db.getSession(workspace.sessionId);
  const project = session ? db.getProject(session.projectId) : null;
  const source = workspace.projectRoot ?? (project ? await git(project.path, ['rev-parse', '--show-toplevel']).then(text => text.trim(), () => workspace.source) : workspace.source);
  const target = workspace.targetBranch ?? await git(source, ['symbolic-ref', '--quiet', 'HEAD']).then(text => text.trim(), () => null);
  store(db, {
    id, commonDir, path, source, projectId: workspace.projectId ?? project?.id ?? null,
    projectName: workspace.projectName ?? project?.name ?? basename(source), sessionId: workspace.sessionId,
    sessionTitle: session?.title ?? null, managed: true, expectedBranch: workspace.branch ? `refs/heads/${workspace.branch}` : null,
    targetBranch: target, createdAt: workspace.createdAt, removedAt: null, ...(project ? {commitSettings:project.commitSettings} : {}),
  });
}

/** Keep the final labels and repository association before session/project deletion. */
export async function archiveSessionWorktree(db: CerebroDatabase, id: string): Promise<void> {
  const row=db.connection.prepare('SELECT data FROM session_workspaces WHERE session_id=?').get(id) as {data:string}|undefined;
  if(!row)return;
  const workspace=JSON.parse(row.data) as Workspace;
  if(workspace.mode!=='isolated'||workspace.removedAt)return;
  if (!records(db).some(record => record.sessionId === id)) await rememberWorktree(db,workspace);
  const session=db.getSession(id);
  for(const record of records(db).filter(r=>r.sessionId===id)){
    const project=session?db.getProject(session.projectId):null;
    if(session){record.sessionTitle=session.title;record.projectId=session.projectId;}
    if(project){record.projectName=project.name;record.commitSettings=project.commitSettings;}
    store(db,record);
  }
}

// Git 2.34 has no `worktree list -z`. Decode its quoted porcelain paths without shell parsing.
function decodePath(path: string): string {
  if (!path.startsWith('"')) return path;
  const pieces: Buffer[] = [];
  const escapes: Record<string, string> = {a:'\x07', b:'\b', f:'\f', n:'\n', r:'\r', t:'\t', v:'\v', '\\':'\\', '"':'"'};
  for (let i = 1; i < path.length - 1;) {
    if (path[i] !== '\\') {
      const point = String.fromCodePoint(path.codePointAt(i)!); pieces.push(Buffer.from(point)); i += point.length; continue;
    }
    i++;
    const octal = /^[0-7]{1,3}/.exec(path.slice(i));
    if (octal) { pieces.push(Buffer.from([parseInt(octal[0], 8)])); i += octal[0].length; }
    else { pieces.push(Buffer.from(escapes[path[i]] ?? path[i])); i++; }
  }
  return Buffer.concat(pieces).toString('utf8');
}
async function registered(path: string): Promise<RegisteredWorktree[]> {
  const output = await git(path, ['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain']);
  return output.split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n');
    const rawPath = lines.find(line => line.startsWith('worktree '));
    if (!rawPath) throw new WorktreeError('Inventaire Git illisible.');
    return { path: canonicalWorktreePath(decodePath(rawPath.slice(9))), head: lines.find(line => line.startsWith('HEAD '))?.slice(5) ?? null,
      branch: lines.find(line => line.startsWith('branch '))?.slice(7) ?? null,
      locked: lines.some(line => /^locked(?: |$)/.test(line)), prunable: lines.some(line => /^prunable(?: |$)/.test(line)) };
  });
}
function changedFiles(status: string): string[] {
  const entries = status.split('\0'); const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]; if (!entry) continue;
    files.push(entry.slice(3)); if (/[RC]/.test(entry.slice(0, 2))) i++;
  }
  return files;
}

export class WorktreeManager {
  private db: CerebroDatabase;
  private syncing: Promise<string[]> | null = null;
  private plans = new Map<string, { id: string; kind: 'merge' | 'remove'; fingerprint: string; expires: number }>();
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  constructor(db: CerebroDatabase) {
    this.db = db;
    for (const operation of this.operations()) if (operation.status === 'running') {
      operation.status = 'interrupted'; operation.error = 'Serveur interrompu : vérifier les références et tout merge en cours avant de relancer.';
      operation.finishedAt = Date.now(); this.saveOperation(operation);
    }
  }
  private operations(): WorktreeOperation[] {
    return (this.db.connection.prepare('SELECT data FROM worktree_operations ORDER BY rowid DESC').all() as {data:string}[]).map(row => JSON.parse(row.data));
  }
  private saveOperation(operation: WorktreeOperation): void {
    this.db.connection.prepare('INSERT INTO worktree_operations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(operation.id, JSON.stringify(operation));
  }
  private async sync(): Promise<string[]> {
    if (this.syncing) return this.syncing;
    this.syncing = this.discover().finally(() => { this.syncing = null; });
    return this.syncing;
  }
  private async discover(): Promise<string[]> {
    const errors: string[] = [];
    const registeredSessions=new Set(records(this.db).map(r=>r.sessionId));
    for (const row of this.db.connection.prepare('SELECT data FROM session_workspaces').all() as {data:string}[]) {
      const workspace = JSON.parse(row.data) as Workspace;
      if (workspace.mode !== 'isolated' || workspace.removedAt || registeredSessions.has(workspace.sessionId)) continue;
      try { await rememberWorktree(this.db, workspace); }
      catch (cause) { if (!records(this.db).some(r => r.sessionId === workspace.sessionId)) errors.push(`Espace ${workspace.root} : ${String(cause)}`); }
    }
    const known = records(this.db);
    const projects = this.db.listProjects();
    const paths = [...new Set([...projects.map(p => p.path), ...known.flatMap(r => [r.path, r.source])])];
    const anchors = new Map<string, string>();
    await Promise.all(paths.map(async path => {
      try { const common = await commonDirectory(path); if (!anchors.has(common)) anchors.set(common, path); } catch { /* Retained records below expose unavailable directories. */ }
    }));
    for (const [commonDir, anchor] of anchors) {
      try {
        const listing = await registered(anchor);
        const project = projects.find(p => listing.some(w => within(w.path, canonicalWorktreePath(p.path))));
        const source = project ? (await git(project.path, ['rev-parse', '--show-toplevel'])).trim() : known.find(r => r.commonDir === commonDir)?.source ?? anchor;
        const target = await git(source, ['symbolic-ref', '--quiet', 'HEAD']).then(text => text.trim(), () => null);
        for (const worktree of listing) {
          const path = resolve(worktree.path); const id = worktreeId(commonDir, path); const previous = records(this.db).find(r => r.id === id);
          if (previous && !previous.removedAt) continue;
          store(this.db, {
            id, commonDir, path, source, projectId: project?.id ?? previous?.projectId ?? null,
            projectName: project?.name ?? previous?.projectName ?? basename(source), sessionId: null, sessionTitle: null,
            managed: false, expectedBranch: worktree.branch, targetBranch: target, createdAt: Date.now(), removedAt: null,
          });
        }
      } catch (cause) { errors.push(`Dépôt ${anchor} : ${String(cause)}`); }
    }
    return errors;
  }
  private record(id: string): WorktreeRecord {
    const record = records(this.db).find(r => r.id === id && !r.removedAt);
    if (!record) throw new WorktreeError('Worktree introuvable.', 404);
    return record;
  }
  private activity(path: string, removing: boolean): string[] {
    const reasons: string[] = [];
    for (const session of this.db.listSessions()) {
      const row = this.db.connection.prepare('SELECT data FROM session_workspaces WHERE session_id=?').get(session.id) as {data:string} | undefined;
      const workspace = row ? JSON.parse(row.data) as Workspace : null;
      const cwd = workspace?.path ?? this.db.getProject(session.projectId)?.path;
      if (cwd && within(path, canonicalWorktreePath(cwd)) && (removing ? session.status !== 'exited' : !['idle','exited'].includes(session.status))) reasons.push(`Session ${session.title} (${session.status}).`);
    }
    for (const row of this.db.connection.prepare('SELECT data FROM command_runs').all() as {data:string}[]) {
      const run = JSON.parse(row.data);
      if (run.status === 'running' && within(path, canonicalWorktreePath(run.cwd))) reasons.push('Une commande utilise ce worktree.');
    }
    for(const row of this.db.connection.prepare('SELECT data FROM automatic_commits').all() as {data:string}[]){
      const run=JSON.parse(row.data);
      if(run.status==='running'&&within(path,canonicalWorktreePath(run.path)))reasons.push('Un commit automatique utilise ce worktree.');
    }
    if (removing) for (const row of this.db.connection.prepare('SELECT data FROM epic_runs').all() as {data:string}[]) {
      const run = JSON.parse(row.data);
      if (['running','waiting-validation','blocked'].includes(run.status) && within(path, canonicalWorktreePath(run.contextRoot))) reasons.push('Un epic utilise encore ce worktree.');
    }
    return reasons;
  }
  async list(projectId?: string): Promise<WorktreeInventory> {
    const errors = await this.sync();
    const project = projectId ? this.db.getProject(projectId) : null;
    if (projectId && !project) throw new WorktreeError('Projet introuvable.', 404);
    const common = project ? await commonDirectory(project.path).catch(() => null) : null;
    const selected = records(this.db).filter(r => !r.removedAt && (!projectId || r.projectId === projectId || r.commonDir === common));
    const worktrees:WorktreeView[]=[];
    for(let i=0;i<selected.length;i+=8)worktrees.push(...await Promise.all(selected.slice(i,i+8).map(record=>this.inspect(record))));
    return {worktrees, errors};
  }
  async get(id: string): Promise<WorktreeView> { await this.sync(); return this.inspect(this.record(id)); }
  private async inspect(record: WorktreeRecord, ownOperation?: string): Promise<WorktreeView> {
    const session = record.sessionId ? this.db.getSession(record.sessionId) : null;
    const view: WorktreeView = {...record, projectName:(record.projectId?this.db.getProject(record.projectId)?.name:null)??record.projectName, projectExists: record.projectId !== null && this.db.getProject(record.projectId) !== null,
      session: session ? {id:session.id,title:session.title,status:session.status} : null,
      primary:false,branch:null,head:null,dirty:null,files:[],ignored:null,ignoredFiles:[],ahead:null,behind:null,targetPath:null,targetHead:null,targets:[],integration:'unknown',mergeInProgress:false,
      activeSessions:[],mergeBlockers:[],removeBlockers:[],fingerprint:null,error:null,operation:this.operations().find(op => op.worktreeId === record.id) ?? null,changesSinceCreation:null};
    try {
      const common = await commonDirectory(record.path);
      if (common !== record.commonDir) throw new WorktreeError('Le chemin désigne un autre dépôt : gestion refusée.');
      const listing = await registered(record.path);
      const entry = listing.find(w => resolve(w.path) === record.path);
      if (!entry) throw new WorktreeError('Ce chemin n’est plus enregistré comme worktree Git.');
      view.primary = await realpath((await git(record.path, ['rev-parse','--absolute-git-dir'])).trim()) === record.commonDir;
      view.branch = entry.branch; view.head = (await git(record.path, ['rev-parse','--verify','HEAD'])).trim();
      view.targets = listing.filter(w => w.branch !== null && resolve(w.path) !== record.path && !w.prunable).map(w => ({branch:w.branch!,path:resolve(w.path)}));
      const target = listing.find(w => w.branch === record.targetBranch && resolve(w.path) !== record.path && !w.prunable);
      view.targetPath = target ? resolve(target.path) : null;
      view.targetHead = record.targetBranch ? await git(record.path,['rev-parse','--verify',record.targetBranch]).then(text => text.trim(), () => null) : null;
      const files = changedFiles(await git(record.path,['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=none']));
      const ignored = (await git(record.path,['ls-files','--others','--ignored','--exclude-standard','-z'])).split('\0').filter(Boolean);
      view.files = files.slice(0,100); view.dirty = files.length; view.ignoredFiles = ignored.slice(0,100); view.ignored = ignored.length;
      if(record.sessionId){
        const row=this.db.connection.prepare('SELECT data FROM session_workspaces WHERE session_id=?').get(record.sessionId) as {data:string}|undefined;
        const workspace=row?JSON.parse(row.data) as Workspace:null;
        if(workspace?.mode==='isolated'&&canonicalWorktreePath(workspace.root)===record.path){
          const changed:string[]=[];
          for(const file of files)if(workspace.baseline[file]!==await workspaceFileSignature(join(record.path,file)))changed.push(file);
          view.changesSinceCreation={count:changed.length,files:changed.slice(0,100),inheritedCount:files.length-changed.length,needsReviewCount:changed.filter(file=>workspace.initialDirty.includes(file)).length};
        }
      }
      const gitDir = (await git(record.path,['rev-parse','--absolute-git-dir'])).trim();
      view.mergeInProgress = existsSync(join(gitDir,'MERGE_HEAD')) || existsSync(join(gitDir,'rebase-merge')) || existsSync(join(gitDir,'rebase-apply')) || existsSync(join(gitDir,'CHERRY_PICK_HEAD')) || existsSync(join(gitDir,'REVERT_HEAD'));
      if (view.targetHead && record.targetBranch !== view.branch) {
        const counts = (await git(record.path,['rev-list','--left-right','--count',`${view.targetHead}...${view.head}`])).trim().split(/\s+/).map(Number);
        view.behind=counts[0]; view.ahead=counts[1]; view.integration = view.ahead === 0 && view.dirty === 0 ? 'integrated' : 'pending';
      }
      const active = this.db.listSessions().filter(s => s.status !== 'exited' && this.activityForSession(s.id,record.path));
      view.activeSessions = active.map(s => ({id:s.id,title:s.title,status:s.status}));
      const commonBlockers: string[] = [];
      if(view.operation?.status==='running'&&view.operation.id!==ownOperation)commonBlockers.push('Une opération Git utilise ce worktree.');
      if (!record.managed || view.primary) commonBlockers.push('Worktree principal ou géré hors de Cerebro : lecture seule.');
      if (view.branch !== record.expectedBranch || !view.branch) commonBlockers.push('Branche du worktree changée ou détachée : vérifier son identité.');
      if (!record.targetBranch || !view.targetHead || record.targetBranch === view.branch) commonBlockers.push('Choisissez une branche cible distincte et existante.');
      if (view.mergeInProgress) commonBlockers.push('Une opération Git doit être résolue dans ce worktree.');
      if (view.dirty) commonBlockers.push(`${view.dirty} fichier(s) modifié(s) ou non suivi(s) : commitez ou conservez-les avant cette action.`);
      if (entry.locked || existsSync(join(gitDir,'index.lock'))) commonBlockers.push('Worktree ou index verrouillé par Git.');
      if ((await currentPush(record.path))?.status === 'running') commonBlockers.push('Un push est en cours.');
      view.removeBlockers = [...commonBlockers,...this.activity(record.path,true)];
      if (view.ahead === null || view.ahead > 0) view.removeBlockers.push('Des commits restent à intégrer, ou leur intégration ne peut pas être vérifiée.');
      if (view.ignored) view.removeBlockers.push(`${view.ignored} fichier(s) ignoré(s) conservé(s) : déplacez-les avant suppression.`);
      view.mergeBlockers = [...commonBlockers,...this.activity(record.path,false)];
      if (!view.targetPath) view.mergeBlockers.push('La branche cible doit être ouverte dans un worktree Git.');
      if (view.ahead === 0) view.mergeBlockers.push('Aucun nouveau commit à intégrer.');
      let targetState = '';
      if (view.targetPath) {
        const dirty = await git(view.targetPath,['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=none']);
        const targetGitDir = (await git(view.targetPath,['rev-parse','--absolute-git-dir'])).trim();
        const pending = ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','index.lock'].filter(name => existsSync(join(targetGitDir,name)));
        if (dirty || pending.length) view.mergeBlockers.push('Le worktree cible doit être propre et sans opération Git en cours.');
        view.mergeBlockers.push(...this.activity(view.targetPath,false));
        targetState = hash(dirty + '\0' + JSON.stringify(pending));
      }
      const index = await readFile(join(gitDir,'index')).catch(cause => { if (cause.code === 'ENOENT') return Buffer.alloc(0); throw cause; });
      view.fingerprint = hash(JSON.stringify([record.path,record.targetBranch,view.branch,view.head,view.targetHead,view.targetPath,files,ignored,targetState,hash(index),entry.locked]));
      // A reference that changed during collection cannot produce an actionable snapshot.
      if (view.head !== (await git(record.path,['rev-parse','HEAD'])).trim() || view.branch !== await git(record.path,['symbolic-ref','--quiet','HEAD']).then(text=>text.trim(),()=>null)
        || view.targetHead !== (record.targetBranch ? await git(record.path,['rev-parse','--verify',record.targetBranch]).then(text=>text.trim(),()=>null) : null)) throw new WorktreeError('Les références ont changé pendant la collecte : actualisez.');
    } catch (cause) {
      view.error = cause instanceof Error ? cause.message : String(cause); view.integration='unknown'; view.fingerprint=null;
      view.mergeBlockers=[view.error]; view.removeBlockers=[view.error];
    }
    return view;
  }
  private activityForSession(id: string, path: string): boolean {
    const row=this.db.connection.prepare('SELECT data FROM session_workspaces WHERE session_id=?').get(id) as {data:string}|undefined;
    const session=this.db.getSession(id)!;
    const cwd=row?(JSON.parse(row.data) as Workspace).path:this.db.getProject(session.projectId)?.path;
    return !!cwd && within(path,canonicalWorktreePath(cwd));
  }
  async target(id: string, branch: unknown): Promise<WorktreeView> {
    if (typeof branch !== 'string' || !branch.startsWith('refs/heads/')) throw new WorktreeError('Branche cible invalide.',400);
    const view=await this.get(id);
    if (!view.targets.some(target=>target.branch===branch)) throw new WorktreeError('Choisissez une branche ouverte dans un autre worktree.',400);
    if (view.operation?.status==='running') throw new WorktreeError('Une opération utilise ce worktree.');
    assertWorktreeAvailable(view.path);
    const record=this.record(id); record.targetBranch=branch; store(this.db,record); return this.inspect(record);
  }
  async prepare(id: string, kind: 'merge' | 'remove'): Promise<{token:string;view:WorktreeView}> {
    const view=await this.get(id); const blockers=kind==='merge'?view.mergeBlockers:view.removeBlockers;
    if (blockers.length || !view.fingerprint) throw new WorktreeError(blockers.join('\n'));
    const token=randomUUID();
    for (const [key,plan] of this.plans) if(plan.expires<Date.now())this.plans.delete(key);
    if(this.plans.size>=100)this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(token,{id,kind,fingerprint:view.fingerprint,expires:Date.now()+10*60_000});
    return {token,view};
  }
  async start(id: string, kind: 'merge' | 'remove', token: unknown): Promise<WorktreeOperation> {
    if(this.closed)throw new WorktreeError('Serveur en cours d’arrêt.');
    const plan=typeof token==='string'?this.plans.get(token):undefined;
    if(!plan||plan.id!==id||plan.kind!==kind||plan.expires<Date.now())throw new WorktreeError('Sélection absente, expirée ou déjà utilisée.');
    const view=await this.get(id);
    if(view.fingerprint!==plan.fingerprint)throw new WorktreeError('L’état Git a changé depuis la confirmation : préparez de nouveau l’action.');
    const blockers=kind==='merge'?view.mergeBlockers:view.removeBlockers;
    if(blockers.length)throw new WorktreeError(blockers.join('\n'));
    if(this.plans.get(token as string)!==plan)throw new WorktreeError('Sélection déjà utilisée.');
    const release=lockWorktrees([view.path,...(kind==='merge'&&view.targetPath?[view.targetPath]:[])]);
    this.plans.delete(token as string);
    const operation:WorktreeOperation={id:randomUUID(),worktreeId:id,kind,status:'running',targetBranch:view.targetBranch,sourceHead:view.head,targetHead:view.targetHead,resultHead:null,output:'',error:null,startedAt:Date.now(),finishedAt:null};
    try { this.saveOperation(operation); } catch(cause) {release();throw cause;}
    const promise=this.execute(view,operation,plan.fingerprint).finally(()=>{release();this.pending.delete(promise);});
    this.pending.add(promise);return {...operation};
  }
  private async execute(view:WorktreeView, operation:WorktreeOperation, fingerprint:string):Promise<void> {
    try {
      const fresh=await this.inspect(this.record(view.id),operation.id);
      if(fresh.fingerprint!==fingerprint)throw new WorktreeError('État Git modifié avant exécution.');
      const blockers=operation.kind==='merge'?fresh.mergeBlockers:fresh.removeBlockers;
      if(blockers.length)throw new WorktreeError(blockers.join('\n'));
      if(operation.kind==='merge') {
        // Keep the exact requested tip recoverable, even if a branch is later rewritten externally.
        await git(view.path,['update-ref',`refs/cerebro/merges/${operation.id}`,view.head!]);
        if((await git(view.targetPath!,['symbolic-ref','--quiet','HEAD'])).trim()!==view.targetBranch)throw new WorktreeError('La branche cible a changé.');
        try { operation.output=await git(view.targetPath!,['merge','--no-edit','--',view.head!]); }
        catch(cause) {
          const failure=cause as Error & {stdout?:string;stderr?:string};
          operation.output=[failure.stdout,failure.stderr].filter(Boolean).join('\n').slice(-64*1024);
          throw new WorktreeError(`Merge interrompu : ${failure.message}\nVérifiez ${view.targetPath}. Les conflits éventuels sont conservés ; aucun reset ni abandon automatique n’a été appliqué.`);
        }
        operation.resultHead=(await git(view.targetPath!,['rev-parse','HEAD'])).trim();
        if((await git(view.targetPath!,['symbolic-ref','--quiet','HEAD'])).trim()!==view.targetBranch)throw new WorktreeError('La branche cible a changé pendant le merge : vérification manuelle requise.');
        await git(view.targetPath!,['merge-base','--is-ancestor',view.head!,'HEAD']);
        operation.output=operation.output.slice(-64*1024);
      } else {
        await git(view.targetPath??view.source,['worktree','remove','--',view.path]);
        const record=this.record(view.id);record.removedAt=Date.now();store(this.db,record);
        if(record.sessionId){
          const row=this.db.connection.prepare('SELECT data FROM session_workspaces WHERE session_id=?').get(record.sessionId) as {data:string}|undefined;
          if(row){const workspace=JSON.parse(row.data) as Workspace;workspace.removedAt=record.removedAt;this.db.connection.prepare('UPDATE session_workspaces SET data=? WHERE session_id=?').run(JSON.stringify(workspace),record.sessionId);}
        }
        operation.output='Worktree supprimé ; branche, commits et conversation conservés.';
      }
      operation.status='succeeded';
    } catch(cause) {operation.status='failed';operation.error=cause instanceof Error?cause.message:String(cause);}
    finally {operation.finishedAt=Date.now();this.saveOperation(operation);}
  }
  async shutdown():Promise<void>{this.closed=true;await Promise.allSettled([...this.pending]);}
}
