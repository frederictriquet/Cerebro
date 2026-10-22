import { ActivityStatus } from './ActivityStatus.tsx';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { StartingContentPlan, StartingContentStep, StartingOrigin, WorktreeInventory, WorktreeView } from '../../server/worktrees.ts';
import type { GitSnapshot } from '../../server/git-plan.ts';
import { api, apiBase } from './api.ts';
import { Modal } from './Dialog.tsx';
import { AutomaticCommitDialog } from './AutomaticCommitDialog.tsx';
import { DelayedActionButton } from './DelayedActionButton.tsx';
import { href } from './route.ts';
import { AGENT_LABEL, MODE_CHIP, sessionTitle } from './format.ts';
import { useStore } from './store.tsx';
import type { Session, WorkspaceMode } from './types.ts';
import './worktrees.css';

const branchName = (branch: string | null): string => branch?.replace(/^refs\/heads\//,'') ?? 'branche inconnue';
const INVENTORY_REFRESH_MS = 30_000;
/** Last inventory per machine and scope, shown on remount so the panel keeps its height while it refreshes. */
const inventoryCache = new Map<string, WorktreeInventory>();
const cacheKey = (machineBase: string, path: string): string => `${machineBase}|${path}`;
const createdLabel = (view: WorktreeView): string => dateLabel(view.createdAt);
const dateLabel = (at: number): string => new Date(at).toLocaleString('fr-FR', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
const copyTitle = (view: WorktreeView): string => sessionTitle(view.session?.title ?? view.sessionTitle ?? `Conversation supprimée · ${createdLabel(view)}`);
const fileCount = (count: number): string => `${count} fichier${count===1?'':'s'}`;
function originLabel(origin: StartingOrigin | null, target: string): string {
  if(!origin)return 'ce contenu n’existe plus que dans cette copie';
  if(origin.kind==='target-commit')return `déjà dans ${target} · ${origin.commit.slice(0,7)} ${origin.subject}`;
  if(origin.kind==='target-worktree')return `toujours présent, non commité, dans le dossier de ${target}`;
  return 'conservé par Cerebro à la création de la copie';
}

type StepState = 'done' | 'todo' | 'blocked' | 'waiting';
/** The path of a copy towards the project: save its work, settle conflicts with the target, integrate, publish. */
interface Journey {
  status: string;
  /** One sentence telling what to do next. */
  next: string | null;
  inherited: StartingContentStep['path'][];
  mixed: { path: string; origin: StartingOrigin | null; separable: boolean }[];
  ownWork: number;
  save: StepState;
  update: StepState;
  integrate: StepState;
}
function journey(view: WorktreeView): Journey {
  const changes = view.changesSinceCreation;
  const starting = view.startingContent ?? [];
  const inherited = starting.filter(file=>file.state==='inherited').map(file=>file.path);
  const mixed = starting.filter(file=>file.state==='mixed');
  const ownWork = changes ? changes.count-changes.needsReviewCount : 0;
  const target = branchName(view.targetBranch);
  const dirty = !!view.dirty;
  const conflicts = view.integrationConflicts;
  const otherBlockers = view.mergeBlockers.filter(reason=>!reason.startsWith('La copie contient'));
  const save: StepState = view.mergeInProgress ? 'waiting' : dirty ? 'todo' : 'done';
  const update: StepState = view.mergeInProgress ? 'todo' : !view.ahead || !view.behind || conflicts?.length===0 ? 'done' : conflicts===null ? 'waiting' : dirty ? 'blocked' : 'todo';
  const integrate: StepState = view.integration==='integrated' ? 'done' : !view.ahead ? 'waiting' : view.mergeBlockers.length ? 'blocked' : 'todo';
  let status: string; let next: string | null;
  if(view.error){status='État indisponible';next=null;}
  else if(view.mergeInProgress){status='Conflits à résoudre';next=view.conflicts.length?`Résolvez les conflits dans la copie (${fileCount(view.conflicts.length)}), puis terminez la mise à jour.`:'Les conflits sont résolus : terminez la mise à jour.';}
  else if(dirty&&!view.ahead&&!changes?.count){status='Copie de départ';next='Aucun travail de la conversation : la copie ne contient que le contenu copié du projet.';}
  else if(dirty&&(inherited.length||mixed.some(file=>file.separable))){status='Contenu de départ à retirer';next=`Retirez le contenu copié du projet à la création (${fileCount(inherited.length+mixed.filter(file=>file.separable).length)}), pour ne garder que le travail de la conversation.`;}
  else if(dirty&&ownWork){status='Travail à enregistrer';next=mixed.length?`Créez le commit du travail de la conversation, puis commitez tel${mixed.length===1?'':'s'} quel${mixed.length===1?'':'s'} ${fileCount(mixed.length)} après lecture de ${mixed.length===1?'son':'leur'} diff.`:'Créez le commit du travail de la conversation.';}
  else if(dirty&&mixed.length){status='Fichiers à commiter tels quels';next=`Lisez le diff de ${fileCount(mixed.length)} qui mêlent contenu de départ et travail récent, puis commitez-${mixed.length===1?'le tel quel':'les tels quels'}.`;}
  else if(dirty){status='Changements à examiner';next=`Examinez ${fileCount(view.dirty!)} : leur origine ne peut pas être vérifiée automatiquement.`;}
  else if(view.ahead&&conflicts?.length){status='Conflits prévus';next=`Mettez la copie à jour avec ${target} pour résoudre ${conflicts.length===1?'le conflit':'les conflits'} dans la copie.`;}
  else if(view.ahead&&otherBlockers.length){status='Intégration bloquée';next=otherBlockers[0];}
  else if(view.ahead){status='Prêt à intégrer';next=`Intégrez ${view.ahead===1?'le commit':`les ${view.ahead} commits`} dans ${target}.`;}
  else if(view.integration==='integrated'){status='Intégré au projet';next=`Le travail est dans ${target} sur cette machine. Utilisez « Push » dans l’en-tête du projet pour le publier.`;}
  else {status='État à vérifier';next=null;}
  return {status,next,inherited,mixed:mixed.map(({path,origin,separable})=>({path,origin,separable})),ownWork,save,update,integrate};
}
const STEP_LABEL: Record<StepState,string> = {done:'Fait',todo:'À faire',blocked:'Bloqué',waiting:'En attente'};
function Step({number,title,state,children}:{number:number;title:string;state:StepState;children?:ReactNode}) {
  return <li className={`worktree-step worktree-step-${state}`}>
    <div className="worktree-step-heading"><span className="worktree-step-number" aria-hidden="true">{state==='done'?'✓':number}</span><strong>{title}</strong><span className="worktree-step-state">{STEP_LABEL[state]}</span></div>
    {children?<div className="worktree-step-body">{children}</div>:null}
  </li>;
}
interface Confirmation { kind:'merge'|'remove';token:string;view:WorktreeView;machineBase:string }

interface Reviewed { snapshotId:string;paths:string[] }
function WorktreeDiffs({view,onCommitReviewed}:{view:WorktreeView;onCommitReviewed?:(reviewed:Reviewed)=>void}) {
  const [snapshot,setSnapshot]=useState<GitSnapshot|null>(null);
  const [checked,setChecked]=useState<Set<string>>(()=>new Set());
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const load=async():Promise<void>=>{
    const machine=apiBase();setBusy(true);setError(null);
    try{const value=await api<GitSnapshot>(`/api/worktrees/${view.id}/git/prepare-commit`,{method:'POST'});if(machine===apiBase()){setSnapshot(value);setChecked(new Set());}}
    catch(cause){if(machine===apiBase())setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(machine===apiBase())setBusy(false);}
  };
  const files=snapshot?.files.filter(file=>!view.changesSinceCreation||view.changesSinceCreation.files.includes(file.path));
  return <div className="worktree-diffs">
    <button type="button" className="btn" disabled={busy} onClick={()=>void load()}><ActivityStatus active={busy}>{busy?'Lecture des changements…':snapshot?'Actualiser les diffs':'Voir les diffs'}</ActivityStatus></button>
    {error?<p className="form-error">{error}</p>:null}
    {snapshot?<p className="meta">Diffs par rapport au dernier commit de la copie : pour les fichiers modifiés avant sa création, ils contiennent aussi le contenu de départ.</p>:null}
    {snapshot&&onCommitReviewed?<p className="meta">Cochez les fichiers dont vous avez lu le diff : le commit les inclura tant que leur contenu reste celui affiché.</p>:null}
    {files?.map(file=><details key={file.path}><summary>{file.path}{file.blocked?' — secret détecté':file.warnings.length?' — à examiner':''}</summary>
      {file.blocked?<p>Contenu masqué : le scanner a détecté un secret.</p>:<>
        {onCommitReviewed?<label className="worktree-reviewed"><input type="checkbox" checked={checked.has(file.path)} onChange={event=>setChecked(current=>{const next=new Set(current);if(event.target.checked)next.add(file.path);else next.delete(file.path);return next;})}/> Examiné : inclure dans le commit</label>:null}
        <pre>{file.diff}</pre>
      </>}
    </details>)}
    {snapshot&&onCommitReviewed?<button type="button" className="btn" disabled={!checked.size} onClick={()=>onCommitReviewed({snapshotId:snapshot.id,paths:[...checked]})}>Commiter avec {checked.size} fichier{checked.size===1?'':'s'} examiné{checked.size===1?'':'s'}</button>:null}
  </div>;
}

const ACTION_LABEL: Record<StartingContentStep['action'],string> = {restore:'remis à l’état de la copie',separate:'seul le travail fait depuis la création est gardé',keep:'laissé tel quel, à examiner'};
interface DiscardResult { restored:string[];separated:string[];kept:StartingContentStep[];targetUpdate:StartingContentPlan['targetUpdate'] }
type Resolver = Pick<Session,'id'|'title'>;
/** Preview, then removal of the content copied from the project when the copy was created. */
function StartingContentDialog({view,onClose,onDone,onResolving}:{view:WorktreeView;onClose:()=>void;onDone:(result:DiscardResult)=>void;onResolving:(session:Resolver)=>void}) {
  const [machineBase]=useState(apiBase);
  const {projects}=useStore();
  const settings=projects.find(project=>project.id===view.projectId)?.resolutionSettings;
  const [plan,setPlan]=useState<StartingContentPlan|null>(null);
  const [busy,setBusy]=useState<'loading'|'running'|'resolving'|null>('loading');
  const [error,setError]=useState<string|null>(null);
  const target=branchName(view.targetBranch);
  useEffect(()=>{
    let disposed=false;
    api<StartingContentPlan>(`/api/worktrees/${view.id}/starting-content`)
      .then(value=>{if(!disposed&&apiBase()===machineBase)setPlan(value);})
      .catch(cause=>{if(!disposed&&apiBase()===machineBase)setError(cause instanceof Error?cause.message:String(cause));})
      .finally(()=>{if(!disposed&&apiBase()===machineBase)setBusy(null);});
    return()=>{disposed=true;};
  },[view.id,machineBase]);
  const run=async():Promise<void>=>{
    setBusy('running');setError(null);
    try{const result=await api<DiscardResult>(`/api/worktrees/${view.id}/discard-inherited`,{method:'POST'});if(apiBase()===machineBase)onDone(result);}
    catch(cause){if(apiBase()===machineBase)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(apiBase()===machineBase)setBusy(null);}
  };
  // The files left for a manual review go to a session working in the copy, with the project's LLM settings.
  const resolve=async():Promise<void>=>{
    setBusy('resolving');setError(null);
    try{const session=await api<Session>(`/api/worktrees/${view.id}/resolve-starting-content`,{method:'POST'});if(apiBase()===machineBase)onResolving(session);}
    catch(cause){if(apiBase()===machineBase)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(apiBase()===machineBase)setBusy(null);}
  };
  const actionable=plan?.steps.some(step=>step.action!=='keep');
  const toReview=plan?.steps.filter(step=>step.action==='keep').length??0;
  return <Modal title="Retirer le contenu de départ" onClose={onClose}>
    <p>{copyTitle(view)}</p>
    <p className="meta">À sa création, la copie a reçu les fichiers alors non commités du dossier du projet. Ce contenu n’est pas le travail de la conversation : le retirer laisse dans la copie uniquement ce qu’elle a changé. Le dossier du projet n’est pas modifié.</p>
    {busy==='loading'?<p><ActivityStatus active>Analyse des fichiers…</ActivityStatus></p>:null}
    {plan?.targetUpdate?<p className="worktree-notice">La copie reçoit d’abord {plan.targetUpdate.commits===1?'le nouveau commit':`les ${plan.targetUpdate.commits} nouveaux commits`} de {branchName(plan.targetUpdate.branch)} (un commit de merge) : le travail gardé s’applique ainsi à la version à jour des fichiers.</p>:null}
    {plan?<ul className="worktree-plan">{plan.steps.map(step=><li key={step.path} className={`worktree-plan-${step.action}`}>
      <code>{step.path}</code> — {ACTION_LABEL[step.action]}
      <div className="meta">Contenu de départ : {originLabel(step.origin,target)}</div>
      {step.reason?<div className={step.action==='keep'?'worktree-warning':'meta'}>{step.reason}</div>:null}
      {step.diff?<details><summary>Travail gardé</summary><pre>{step.diff}</pre></details>:null}
    </li>)}</ul>:null}
    {plan&&!actionable?<p className="worktree-warning">Aucun fichier ne peut être traité automatiquement : examinez-les dans les diffs{toReview?', ou confiez-les à l’IA':''}.</p>:null}
    {toReview?<p className="meta">« Résoudre avec l’IA » lance une session dans la copie pour séparer le contenu de départ du travail de la conversation dans {toReview===1?'le fichier laissé':`les ${toReview} fichiers laissés`} à examiner. Elle ne commite rien : relisez ensuite ses changements, puis retirez le contenu de départ restant.{settings?` Session : ${AGENT_LABEL[settings.agent]} · ${settings.model??'modèle par défaut'} · ${settings.effort??'effort par défaut'} · ${MODE_CHIP[settings.mode]} (« Réglages LLM » du projet).`:''}</p>:null}
    {error?<p className="form-error" role="alert">{error}</p>:null}
    <div className="row-actions">
      <button type="button" className="btn primary" disabled={busy!==null||!actionable} onClick={()=>void run()}><ActivityStatus active={busy==='running'}>{busy==='running'?'Retrait du contenu de départ…':'Retirer le contenu de départ'}</ActivityStatus></button>
      {toReview?<button type="button" className="btn" disabled={busy!==null} onClick={()=>void resolve()}><ActivityStatus active={busy==='resolving'}>{busy==='resolving'?'Lancement de la session…':'Résoudre avec l’IA'}</ActivityStatus></button>:null}
      <button type="button" className="btn" disabled={busy==='running'||busy==='resolving'} onClick={onClose}>Annuler</button>
    </div>
  </Modal>;
}

/** Keep preserved work visible, without presenting the main repository as another pending session. */
export function Worktrees({projectId,workspaceMode}:{projectId?:string;workspaceMode?:WorkspaceMode}) {
  const path=projectId?`/api/projects/${projectId}/worktrees`:'/api/worktrees';
  const machineBase=apiBase();
  const [inventory,setInventory]=useState<WorktreeInventory|null>(()=>inventoryCache.get(cacheKey(machineBase,path))??null);
  const [loadedBase,setLoadedBase]=useState<string|null>(()=>inventoryCache.has(cacheKey(machineBase,path))?machineBase:null);
  const [loadError,setLoadError]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState<string|null>(null);
  const [historyBusy,setHistoryBusy]=useState<Set<string>>(()=>new Set());
  const [confirmation,setConfirmation]=useState<Confirmation|null>(null);
  const [discarding,setDiscarding]=useState<WorktreeView|null>(null);
  const [results,setResults]=useState<Map<string,DiscardResult>>(()=>new Map());
  const [resolvers,setResolvers]=useState<Map<string,Resolver>>(()=>new Map());
  const [committing,setCommitting]=useState<WorktreeView|null>(null);
  const [reviewed,setReviewed]=useState<Reviewed|null>(null);
  const [expanded,setExpanded]=useState<Set<string>>(()=>new Set());
  const refresh=useCallback(async():Promise<void>=>{
    try{const result=await api<WorktreeInventory>(path);if(apiBase()===machineBase){inventoryCache.set(cacheKey(machineBase,path),result);setInventory(result);setLoadedBase(machineBase);setLoadError(null);}}
    catch(cause){if(apiBase()===machineBase)setLoadError(cause instanceof Error?cause.message:String(cause));}
  },[path,machineBase]);
  useEffect(()=>{
    const cached=inventoryCache.get(cacheKey(machineBase,path))??null;
    setInventory(cached);setLoadedBase(cached?machineBase:null);setConfirmation(null);setDiscarding(null);setResults(new Map());setResolvers(new Map());setCommitting(null);setReviewed(null);setError(null);setLoadError(null);setBusy(null);setHistoryBusy(new Set());setExpanded(new Set());
    let disposed=false;let loading=false;let timer:number|undefined;
    const load=async():Promise<void>=>{
      if(disposed||loading)return;
      loading=true;timer=undefined;
      try{if(!document.hidden)await refresh();}
      finally{loading=false;if(!disposed)timer=window.setTimeout(()=>void load(),INVENTORY_REFRESH_MS);}
    };
    const visible=():void=>{if(!document.hidden&&!loading){if(timer!==undefined)window.clearTimeout(timer);timer=undefined;void load();}};
    document.addEventListener('visibilitychange',visible);void load();
    return()=>{disposed=true;if(timer!==undefined)window.clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
  },[refresh]);
  const prepare=async(view:WorktreeView,kind:'merge'|'remove'):Promise<void>=>{
    if(apiBase()!==machineBase)return;
    setBusy(view.id);setError(null);
    try{const prepared=await api<{token:string;view:WorktreeView}>(`/api/worktrees/${view.id}/prepare-${kind}`,{method:'POST'});if(apiBase()===machineBase)setConfirmation({kind,...prepared,machineBase});}
    catch(cause){if(apiBase()===machineBase)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(apiBase()===machineBase)setBusy(null);}
  };
  const run=async():Promise<void>=>{
    if(!confirmation||confirmation.machineBase!==apiBase())return;
    const {view,kind,token}=confirmation;setBusy(view.id);setError(null);
    try{
      await api(`/api/worktrees/${view.id}/${kind}`,{method:'POST',body:JSON.stringify({token})});
      if(apiBase()!==machineBase)return;
      setConfirmation(null);await refresh();window.setTimeout(()=>void refresh(),500);
    }catch(cause){if(apiBase()===machineBase)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(apiBase()===machineBase)setBusy(null);}
  };
  /** A synchronous Git action on one copy, followed by a refresh. */
  const act=async(view:WorktreeView,action:string):Promise<void>=>{
    if(apiBase()!==machineBase)return;
    setBusy(view.id);setError(null);
    try{await api(`/api/worktrees/${view.id}/${action}`,{method:'POST'});if(apiBase()===machineBase)await refresh();}
    catch(cause){if(apiBase()===machineBase)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(apiBase()===machineBase)setBusy(null);}
  };
  const chooseTarget=async(view:WorktreeView,branch:string):Promise<void>=>{
    if(apiBase()!==machineBase)return;
    setBusy(view.id);setError(null);
    try{await api(`/api/worktrees/${view.id}/target`,{method:'PATCH',body:JSON.stringify({branch})});if(apiBase()===machineBase)await refresh();}
    catch(cause){if(apiBase()===machineBase)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(apiBase()===machineBase)setBusy(null);}
  };
  const toggle=(id:string):void=>setExpanded(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next;});
  const open=(id:string):void=>setExpanded(current=>new Set(current).add(id));
  const deleteHistory=async(ids:string[],actionKey:string):Promise<void>=>{
    if(apiBase()!==machineBase)return;
    // Only disable the action being executed: disabling another delayed button cancels its timer.
    setHistoryBusy(current=>new Set(current).add(actionKey));setError(null);
    try {
      await api('/api/worktrees/history',{method:'DELETE',body:JSON.stringify({ids})});
      if(apiBase()!==machineBase)return;
      // Invalidate other scopes on this machine too, so remounting cannot restore deleted entries.
      for(const [key,value] of inventoryCache)if(key.startsWith(`${machineBase}|`))inventoryCache.set(key,{...value,cleaned:value.cleaned?.filter(copy=>!ids.includes(copy.id))??[]});
      setInventory(current=>current?{...current,cleaned:current.cleaned?.filter(copy=>!ids.includes(copy.id))??[]}:current);
      await refresh();
    } catch(cause) {if(apiBase()===machineBase)setError(cause instanceof Error?cause.message:String(cause));}
    finally {if(apiBase()===machineBase)setHistoryBusy(current=>{const next=new Set(current);next.delete(actionKey);return next;});}
  };
  const visibleInventory=loadedBase===machineBase?inventory:null;
  const copies=visibleInventory?.worktrees.filter(view=>view.managed&&!view.primary)??[];
  const other=visibleInventory?.worktrees.filter(view=>!view.managed||view.primary)??[];
  // Absent des serveurs antérieurs au nettoyage automatique.
  const cleaned=visibleInventory?.cleaned??[];
  const historyOnly=!!projectId&&workspaceMode==='shared'&&!!visibleInventory&&copies.length===0&&other.every(view=>view.primary)&&!loadError&&!visibleInventory.errors.length;
  if(projectId&&workspaceMode==='shared'&&visibleInventory&&copies.length===0&&cleaned.length===0&&other.every(view=>view.primary)&&!loadError&&!error&&!visibleInventory.errors.length)return null;
  return <section className="card worktrees-panel" aria-label="Copies de travail des conversations">
    {!historyOnly?<><div className="worktrees-heading"><h2>Copies de travail <span className="pill">{visibleInventory?copies.length:'…'}</span></h2>
      <button type="button" className="btn" onClick={()=>void refresh()}>Actualiser</button>
    </div>
    <p className="worktrees-explanation">{workspaceMode==='shared'?'Ce projet utilise directement son dossier. Ses anciennes copies isolées restent accessibles ici.':'Chaque conversation travaille dans sa copie, sur sa propre branche. Pour récupérer son travail : l’enregistrer (commit) dans la copie, régler les conflits éventuels avec la branche du projet, l’intégrer, puis le publier avec « Push ». Une copie sans rien à conserver est nettoyée automatiquement à la fin de sa conversation.'}</p></>:null}
    {loadError?<p className="form-error" role="alert">{loadError}</p>:null}
    {error?<p className="form-error" role="alert">{error}</p>:null}
    {visibleInventory?.errors.map(message=><p className="form-error" key={message}>{message}</p>)}
    {!historyOnly&&visibleInventory&&copies.length===0?<p className="empty-hint">Aucune copie de conversation à traiter.</p>:null}
    <ul className="worktree-list">
      {copies.map(view=>{
        const operationBusy=view.operation?.status==='running';const disabled=busy!==null||operationBusy;
        const showDetails=expanded.has(view.id);const changes=view.changesSinceCreation;
        const plan=journey(view);const target=branchName(view.targetBranch);
        const commitBlocked=disabled||!!view.error||view.mergeInProgress||view.activeSessions.some(session=>session.status!=='idle');
        const separable=plan.mixed.filter(file=>file.separable);const manual=plan.mixed.filter(file=>!file.separable);
        const removable=plan.inherited.length>0||separable.length>0;
        const result=results.get(view.id);const resolver=resolvers.get(view.id);
        const startDiscard=():void=>setDiscarding(view);
        const integrateTitle=view.mergeBlockers.join('\n')||(view.integrationConflicts?.length?`Conflits prévus : ${view.integrationConflicts.join(', ')}`:`Intégrer dans ${target}`);
        // The next action, also offered in the overview so the usual path needs no expansion.
        const primary=view.error?null
          :view.mergeInProgress?<button type="button" className="btn primary" onClick={()=>open(view.id)}>Résoudre les conflits</button>
          :view.dirty&&removable?<button type="button" className="btn primary" disabled={commitBlocked} onClick={startDiscard}>Retirer le contenu de départ</button>
          :view.dirty&&plan.ownWork?<button type="button" className="btn primary" disabled={commitBlocked} onClick={()=>setCommitting(view)}>Créer le commit</button>
          :view.dirty&&changes?.count!==0?<button type="button" className="btn primary" onClick={()=>open(view.id)}>Examiner</button>
          :view.ahead&&view.integrationConflicts?.length?<button type="button" className="btn primary" disabled={commitBlocked} onClick={()=>void act(view,'update-from-target')}>Mettre à jour avec {target}</button>
          :view.ahead?<button type="button" className={`btn ${view.mergeBlockers.length?'':'primary'}`} disabled={disabled||view.mergeBlockers.length>0} title={integrateTitle} onClick={()=>void prepare(view,'merge')}>Intégrer dans {target}</button>
          :null;
        return <li className="worktree-row" key={view.id}>
          <div className="worktree-overview">
            <div className="worktree-identity">
              <div className="worktree-title">
                <strong title={copyTitle(view)}>{view.session?<a href={href(`#/s/${view.session.id}`)}>{copyTitle(view)}</a>:copyTitle(view)}</strong>
                <span className={`pill ${plan.status!=='Intégré au projet'&&plan.status!=='Copie de départ'?'worktree-pending':''}`}>{plan.status}</span>
              </div>
              <div className="worktree-meta">
                {!projectId?<span className="worktree-context">{view.projectName}{view.projectExists?'':' (projet retiré)'}</span>:null}
                <span>{view.session?'Conversation conservée':view.sessionTitle?'Conversation supprimée':'Titre d’origine indisponible'}</span>
                <span className="worktree-destination">Cible : {target}</span>
              </div>
              {plan.next?<p className="worktree-guidance">{plan.next}</p>:null}
            </div>
            <div className="worktree-counts">
              {view.dirty&&!view.mergeInProgress?<span title="Fichiers modifiés et non commités dans la copie, contenu de départ compris.">{fileCount(view.dirty)} non commité{view.dirty===1?'':'s'}</span>:null}
              {view.ahead?<span>{view.ahead} commit{view.ahead===1?'':'s'} à intégrer</span>:null}
            </div>
            <div className="worktree-actions">
              {primary}
              <button type="button" className="btn worktree-toggle" aria-expanded={showDetails} aria-controls={`worktree-details-${view.id}`} onClick={()=>toggle(view.id)}>{showDetails?'Réduire':'Étapes'}</button>
            </div>
          </div>
          {/* A failed merge finished by hand (conflict resolved in the project) no longer needs attention. */}
          {view.operation&&!(view.operation.kind==='merge'&&view.operation.status!=='running'&&view.integration==='integrated'&&view.operation.sourceHead===view.head)?<div className={`worktree-operation-status ${view.operation.status==='failed'||view.operation.status==='interrupted'?'worktree-operation-error':''}`} role="status">
            {view.operation.kind==='merge'?'Intégration':'Retrait de la copie'} {({running:'en cours…',succeeded:'terminé',failed:'échoué',interrupted:'interrompu'})[view.operation.status]}
            {view.operation.error?<span> · {view.operation.error}</span>:null}
          </div>:null}
          <div className="worktree-detail" id={`worktree-details-${view.id}`} hidden={!showDetails}>
            <p className="path">{view.path}</p><p className="meta">Branche : {branchName(view.branch??view.expectedBranch)} · Créée le {createdLabel(view)}</p>
            {view.error?<p className="form-error">{view.error}</p>:null}
            <ol className="worktree-steps">
              <Step number={1} title="Enregistrer le travail dans la copie" state={plan.save}>
                {view.mergeInProgress?<p>Une mise à jour avec {target} est en cours : terminez-la ou annulez-la à l’étape 2 avant d’enregistrer d’autres changements.</p>
                :!view.dirty?<p>Aucun changement non commité : tout le travail de la copie est dans ses commits.</p>:null}
                {result&&view.dirty?<p className="worktree-notice" role="status">
                  {result.targetUpdate?`Copie mise à jour avec ${branchName(result.targetUpdate.branch)}. `:''}
                  {result.restored.length?`${fileCount(result.restored.length)} remis à l’état de la copie. `:''}
                  {result.separated.length?`${fileCount(result.separated.length)} ${result.separated.length===1?'ne contient':'ne contiennent'} plus que le travail fait depuis la création. `:''}
                  {result.kept.length?`Non séparé${result.kept.length===1?'':'s'} : ${result.kept.map(step=>step.path).join(', ')}, à commiter tel${result.kept.length===1?'':'s'} quel${result.kept.length===1?'':'s'} ci-dessous.`:''}
                </p>:null}
                {resolver?<p className="worktree-notice" role="status">Session de résolution lancée dans la copie : <a href={href(`#/s/${resolver.id}`)}>{sessionTitle(resolver.title)}</a>. Une fois son tour terminé, relisez ses changements dans les diffs, puis retirez le contenu de départ restant.</p>:null}
                {!view.mergeInProgress&&plan.inherited.length?<div className="worktree-group">
                  <p><strong>{fileCount(plan.inherited.length)} sans nouveau travail.</strong> {plan.inherited.length===1?'Ce fichier a':'Ces fichiers ont'} encore le contenu copié du dossier du projet à la création de la copie : ce n’est pas le travail de la conversation.</p>
                  <ul className="worktree-files">{(view.startingContent??[]).filter(file=>file.state==='inherited').map(file=><li key={file.path}><code>{file.path}</code> <span className={file.origin?'meta':'worktree-warning'}>— {originLabel(file.origin,target)}</span></li>)}</ul>
                </div>:null}
                {!view.mergeInProgress&&separable.length?<div className="worktree-group">
                  <p><strong>{fileCount(separable.length)} mêlant contenu de départ et travail récent, séparable{separable.length===1?'':'s'}.</strong> Le contenu de départ peut en être retiré automatiquement, en gardant le travail fait dans la copie.</p>
                  <ul className="worktree-files">{separable.map(file=><li key={file.path}><code>{file.path}</code> <span className="meta">— contenu de départ {originLabel(file.origin,target)}</span></li>)}</ul>
                </div>:null}
                {!view.mergeInProgress&&removable&&view.dirty?<button type="button" className="btn primary" disabled={commitBlocked} onClick={startDiscard}>Retirer le contenu de départ…</button>:null}
                {!view.mergeInProgress&&plan.ownWork&&view.dirty?<div className="worktree-group">
                  <p><strong>{fileCount(plan.ownWork)} modifié{plan.ownWork===1?'':'s'} par la conversation.</strong> Le commit automatique ne prend que les fichiers dont l’origine est vérifiable.</p>
                  <button type="button" className="btn" disabled={commitBlocked} onClick={()=>setCommitting(view)}>Créer le commit</button>
                </div>:null}
                {!view.mergeInProgress&&view.dirty&&(manual.length||!changes)?<div className="worktree-group">
                  {manual.length?<>
                    <p><strong>{fileCount(manual.length)} à commiter tel{manual.length===1?'':'s'} quel{manual.length===1?'':'s'}.</strong> {manual.length===1?'Il mêle':'Ils mêlent'} contenu de départ et travail récent, sans séparation automatique possible :</p>
                    <ul className="worktree-files">{manual.map(file=><li key={file.path}><code>{file.path}</code> <span className="worktree-warning">— {file.origin?`contenu de départ ${originLabel(file.origin,target)}, mais le travail récent touche les mêmes lignes ou a déjà été commité`:'contenu de départ introuvable'}</span></li>)}</ul>
                    <p className="meta">Pour terminer cette étape, {manual.length===1?'lisez son diff puis cochez-le : le commit emportera aussi son':'lisez leur diff puis cochez-les : le commit emportera aussi leur'} contenu de départ. S’il diffère de {target}, l’écart apparaîtra comme conflit à l’étape 2 et se résoudra dans la copie. Pour ne garder que le travail de la conversation, confiez plutôt {manual.length===1?'ce fichier':'ces fichiers'} à l’IA : une session sépare le contenu de départ dans la copie, sans rien commiter.</p>
                    <button type="button" className="btn" disabled={commitBlocked} onClick={startDiscard}>Résoudre avec l’IA…</button>
                  </>:<p className="meta">L’origine de ces changements ne peut pas être vérifiée : lisez leur diff puis cochez ceux à commiter.</p>}
                  {showDetails?<WorktreeDiffs view={view} onCommitReviewed={commitBlocked?undefined:value=>{setReviewed(value);setCommitting(view);}}/>:null}
                </div>:null}
              </Step>
              <Step number={2} title={`Régler les conflits avec ${target}`} state={plan.update}>
                {view.mergeInProgress?<>
                  {view.conflicts.length?<><p>Mise à jour en cours : {view.conflicts.length===1?'ce fichier est':'ces fichiers sont'} en conflit dans la copie.</p><ul className="worktree-files">{view.conflicts.map(file=><li key={file}><code>{file}</code></li>)}</ul>
                    <p className="meta">Résolvez-les dans le dossier de la copie, vous-même ou en le demandant à la conversation{view.session?<> (<a href={href(`#/s/${view.session.id}`)}>ouvrir la conversation</a>)</>:null}, puis terminez la mise à jour.</p></>
                    :<p>Les conflits sont résolus : terminez la mise à jour pour créer le commit de merge.</p>}
                  <div className="row-actions">
                    <button type="button" className="btn primary" disabled={disabled} onClick={()=>void act(view,'update-from-target/finish')}>Terminer la mise à jour</button>
                    <button type="button" className="btn danger-ghost" disabled={disabled} onClick={()=>void act(view,'update-from-target/abort')}>Annuler la mise à jour</button>
                  </div>
                </>
                :!view.ahead?<p>{view.integration==='integrated'?'Rien à régler : tout le travail commité est déjà dans la cible.':'Rien à intégrer pour l’instant.'}</p>
                :!view.behind?<p>La copie contient déjà tous les commits de {target} : aucun conflit possible.</p>
                :view.integrationConflicts===null?<p><ActivityStatus active>Recherche des conflits avec {target}…</ActivityStatus></p>
                :view.integrationConflicts.length===0?<p>Aucun conflit prévu avec {target}, qui a reçu {view.behind} commit{view.behind===1?'':'s'} depuis la création de la copie.</p>
                :<>
                  <p>Les commits de la copie et ceux de {target} modifient les mêmes lignes de {fileCount(view.integrationConflicts.length)} :</p>
                  <ul className="worktree-files">{view.integrationConflicts.map(file=><li key={file}><code>{file}</code></li>)}</ul>
                  <p className="meta">Mettez d’abord la copie à jour avec {target} : les conflits se résolvent alors dans la copie, sans toucher au dossier du projet.</p>
                  {view.dirty?<p className="worktree-warning">Terminez d’abord l’étape 1 : la copie doit être entièrement commitée.</p>:null}
                  <button type="button" className="btn primary" disabled={commitBlocked||!!view.dirty} onClick={()=>void act(view,'update-from-target')}>Mettre à jour avec {target}</button>
                </>}
              </Step>
              <Step number={3} title={`Intégrer dans ${target}`} state={plan.integrate}>
                <div className="worktree-target"><label>Branche cible <select aria-label={`Cible de ${copyTitle(view)}`} value={view.targetBranch??''} disabled={disabled} onChange={event=>void chooseTarget(view,event.target.value)}>
                  {!view.targets.some(target=>target.branch===view.targetBranch)?<option value={view.targetBranch??''}>{view.targetBranch?`${branchName(view.targetBranch)} (dossier non ouvert)`:'Choisir une branche'}</option>:null}
                  {view.targets.map(target=><option key={target.branch} value={target.branch}>{branchName(target.branch)} — {target.path}</option>)}
                </select></label></div>
                {view.integration==='integrated'&&!view.ahead?<p>Tout le travail commité de la copie est dans {target}.</p>
                  :view.ahead&&view.mergeBlockers.length?<><p>L’intégration attend :</p><ul>{view.mergeBlockers.map(reason=><li key={reason}>{reason}</li>)}</ul></>
                  :view.ahead?<p>{view.ahead===1?'Le commit sera intégré':`Les ${view.ahead} commits seront intégrés`} par un merge dans {view.targetPath}.</p>
                  :<p>Aucun commit à intégrer : enregistrez d’abord le travail (étape 1).</p>}
                {view.ahead?<button type="button" className={`btn ${view.mergeBlockers.length||view.integrationConflicts?.length?'':'primary'}`} disabled={disabled||view.mergeBlockers.length>0} title={integrateTitle} onClick={()=>void prepare(view,'merge')}>Intégrer dans {target}</button>:null}
              </Step>
              <Step number={4} title="Publier" state={view.integration==='integrated'&&!view.ahead?'todo':'waiting'}>
                <p>L’intégration reste locale à cette machine. Pour envoyer le travail vers le dépôt distant, utilisez « Push » dans l’en-tête du projet ({target}).</p>
              </Step>
            </ol>
            {view.operation?.output?<details><summary>Résultat Git</summary><pre>{view.operation.output}</pre></details>:null}
            <details className="worktree-cleanup"><summary>Retirer cette copie</summary>
              <p>Le retrait est distinct de la suppression de la conversation. Il est disponible uniquement quand les changements sont intégrés et qu’aucune donnée locale ne risque d’être effacée. Il a lieu automatiquement à l’arrêt ou à la suppression de la conversation quand ces conditions sont réunies.</p>
              {view.autoCleanup&&view.autoCleanup.status!=='removed'?<p>Nettoyage automatique {view.autoCleanup.status==='failed'?'échoué':'non effectué'} le {dateLabel(view.autoCleanup.at)} : {view.autoCleanup.reasons.join(' ')}</p>:null}
              {view.ignored?<p>{view.ignored} fichier(s) ignoré(s) par Git sont présents (par exemple dépendances ou configuration locale). Ce ne sont pas des changements à intégrer ; ils sont conservés et empêchent le retrait de la copie.</p>:null}
              {view.removeBlockers.length?<ul>{view.removeBlockers.map(reason=><li key={reason}>{reason}</li>)}</ul>:null}
              <button type="button" className="btn danger-ghost" disabled={disabled||view.removeBlockers.length>0} onClick={()=>void prepare(view,'remove')}>Retirer la copie</button>
            </details>
          </div>
        </li>;
      })}
    </ul>
    {cleaned.length?<details className={`worktrees-history${historyOnly?' worktrees-history-only':''}`}><summary>Historique des copies nettoyées ({cleaned.length}) · Aucune action requise</summary>
      <p className="meta">Ces anciens dossiers de travail ont déjà été supprimés. Les branches Git et les conversations encore présentes sont conservées. Supprimer une entrée retire uniquement sa trace de cet historique.</p>
      <DelayedActionButton disabled={historyBusy.has('all')} title="Retire uniquement les entrées affichées de l’historique ; branches et conversations conservées." onAction={()=>void deleteHistory(cleaned.map(copy=>copy.id),'all')}>Effacer {cleaned.length===1?'l’entrée affichée':`les ${cleaned.length} entrées affichées`}</DelayedActionButton>
      <ul className="worktree-list">{cleaned.map(copy=><li className="worktree-cleaned-row" key={copy.id}>
        <div className="worktree-history-heading"><strong>{copy.session?<a href={href(`#/s/${copy.session.id}`)}>{sessionTitle(copy.session.title)}</a>:sessionTitle(copy.sessionTitle??'Conversation supprimée')}</strong>
          <DelayedActionButton disabled={historyBusy.has(copy.id)} title={`Supprimer de l’historique : ${sessionTitle(copy.session?.title??copy.sessionTitle??'Conversation supprimée')}. Branche et conversation conservées.`} onAction={()=>void deleteHistory([copy.id],copy.id)}>Supprimer</DelayedActionButton>
        </div>
        {!projectId?<span className="meta"> · {copy.projectName}</span>:null}
        <p className="meta">Nettoyée le {dateLabel(copy.removedAt)}</p>
        <details className="worktree-history-details"><summary>Détails techniques</summary>
          <p className="meta">Branche conservée : {branchName(copy.branch)}</p>
          <p className="path">Ancien dossier supprimé : {copy.path}</p>
        </details>
      </li>)}</ul>
    </details>:null}
    {!historyOnly&&other.length?<details className="worktrees-other"><summary>Dossier principal et autres copies Git ({other.length})</summary>
      <p className="meta">Le dossier principal se traite avec « Commit / push du projet ». Les copies non associées restent visibles ici pour retrouver leur contenu.</p>
      {other.map(view=><details className="worktree-other" key={view.id}><summary>{view.primary?'Dossier principal du projet':'Copie sans conversation identifiée'}{!projectId?` · ${view.projectName}`:''} · {view.dirty??'?'} fichier(s) modifié(s)</summary>
        <p className="path">{view.path}</p><p className="meta">Branche : {branchName(view.branch??view.expectedBranch)}</p>
        <p>{view.primary?'C’est le dossier utilisé par le projet et les conversations historiques. Il n’a pas à être intégré dans lui-même.':'Les données de création de cette copie ne sont pas disponibles. Cerebro ne peut ni attribuer son contenu à une conversation, ni la retirer automatiquement.'}</p>
        {view.error?<p className="form-error">{view.error}</p>:null}
        {!view.primary?<WorktreeDiffs view={view}/>:null}
        {view.primary&&view.projectExists&&view.projectId?<button type="button" className="btn" onClick={()=>setCommitting(view)}>Commit / push du projet</button>:null}
      </details>)}
    </details>:null}
    {confirmation&&confirmation.machineBase===machineBase?<Modal title={confirmation.kind==='merge'?`Intégrer dans ${branchName(confirmation.view.targetBranch)}`:'Retirer la copie de travail'} onClose={()=>setConfirmation(null)}>
      <p>{copyTitle(confirmation.view)}</p><p>Copie : {confirmation.view.path}</p><p>Projet cible : {confirmation.view.targetPath} · {branchName(confirmation.view.targetBranch)}</p>
      {confirmation.kind==='merge'?<>
        <p>Les commits de cette copie seront intégrés au projet par un merge. Les contrôles Git habituels s’appliquent.</p>
        {confirmation.view.integrationConflicts?.length?<p className="worktree-warning">Conflits prévus dans {confirmation.view.integrationConflicts.join(', ')} : ils resteront à résoudre dans {confirmation.view.targetPath}. Pour les résoudre plutôt dans la copie, annulez et utilisez « Mettre à jour avec {branchName(confirmation.view.targetBranch)} ».</p>:null}
        <p>Ensuite, publiez avec « Push » dans l’en-tête du projet. La conversation peut continuer dans sa copie ; ses nouveaux changements pourront être intégrés plus tard.</p>
      </>:<p>La copie propre et intégrée sera retirée. Sa branche, ses commits et la conversation seront conservés. Cette conversation ne pourra plus reprendre dans la copie supprimée.</p>}
      {error?<p className="form-error" role="alert">{error}</p>:null}
      <div className="row-actions"><button type="button" className={`btn ${confirmation.kind==='merge'?'primary':'danger-ghost'}`} disabled={busy!==null} onClick={()=>void run()}><ActivityStatus active={busy!==null}>{busy!==null?(confirmation.kind==='merge'?'Intégration…':'Retrait de la copie…'):(confirmation.kind==='merge'?`Intégrer dans ${branchName(confirmation.view.targetBranch)}`:'Retirer la copie')}</ActivityStatus></button><button type="button" className="btn" disabled={busy!==null} onClick={()=>setConfirmation(null)}>Annuler</button></div>
    </Modal>:null}
    {discarding&&loadedBase===machineBase?<StartingContentDialog view={discarding} onClose={()=>setDiscarding(null)} onDone={result=>{
      setResults(current=>new Map(current).set(discarding.id,result));setDiscarding(null);open(discarding.id);void refresh();
    }} onResolving={session=>{
      setResolvers(current=>new Map(current).set(discarding.id,session));setDiscarding(null);open(discarding.id);void refresh();
    }}/>:null}
    {committing&&loadedBase===machineBase?<AutomaticCommitDialog projectId={committing.projectId??''} reviewed={reviewed??undefined} endpoint={committing.primary?undefined:`/api/worktrees/${committing.id}/git`} push={committing.primary} scopeLabel={committing.primary?'Tous les changements du dossier partagé du projet':`Fichiers vérifiables de la copie · ${copyTitle(committing)}`} onClose={()=>{setCommitting(null);setReviewed(null);void refresh();}}/>:null}
  </section>;
}
