import { useCallback, useEffect, useState } from 'react';
import type { WorktreeInventory, WorktreeView } from '../../server/worktrees.ts';
import type { GitSnapshot } from '../../server/git-plan.ts';
import { api, apiBase } from './api.ts';
import { Modal } from './Dialog.tsx';
import { AutomaticCommitDialog } from './AutomaticCommitDialog.tsx';
import { href } from './route.ts';
import type { WorkspaceMode } from './types.ts';
import './worktrees.css';

const branchName = (branch: string | null): string => branch?.replace(/^refs\/heads\//,'') ?? 'branche inconnue';
const INVENTORY_REFRESH_MS = 30_000;
const createdLabel = (view: WorktreeView): string => new Date(view.createdAt).toLocaleString('fr-FR', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
const copyTitle = (view: WorktreeView): string => view.session?.title ?? view.sessionTitle ?? `Conversation supprimée · ${createdLabel(view)}`;
function copyStatus(view: WorktreeView): string {
  if(view.error)return 'État indisponible';
  if(view.mergeInProgress)return 'Conflit à résoudre';
  if(view.changesSinceCreation?.count===0&&view.ahead===0&&view.dirty)return 'Copie de départ';
  if(view.changesSinceCreation?.needsReviewCount||!view.changesSinceCreation&&view.dirty)return 'Changements à examiner';
  if(view.dirty)return 'Changements à enregistrer';
  if(view.ahead)return view.mergeBlockers.length?'Intégration bloquée':'Prêt à intégrer';
  if(view.integration==='integrated')return 'Intégré au projet';
  return 'État à vérifier';
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
    <button type="button" className="btn" disabled={busy} onClick={()=>void load()}>{busy?'Lecture des changements…':snapshot?'Actualiser les diffs':'Voir les diffs'}</button>
    {error?<p className="form-error">{error}</p>:null}
    {snapshot?<p className="meta">Diffs par rapport au dernier commit : ils peuvent aussi contenir des changements présents avant la création de la copie.</p>:null}
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

/** Keep preserved work visible, without presenting the main repository as another pending session. */
export function Worktrees({projectId,workspaceMode}:{projectId?:string;workspaceMode?:WorkspaceMode}) {
  const [inventory,setInventory]=useState<WorktreeInventory|null>(null);
  const [loadedBase,setLoadedBase]=useState<string|null>(null);
  const [loadError,setLoadError]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState<string|null>(null);
  const [confirmation,setConfirmation]=useState<Confirmation|null>(null);
  const [committing,setCommitting]=useState<WorktreeView|null>(null);
  const [reviewed,setReviewed]=useState<Reviewed|null>(null);
  const [expanded,setExpanded]=useState<Set<string>>(()=>new Set());
  const path=projectId?`/api/projects/${projectId}/worktrees`:'/api/worktrees';
  const machineBase=apiBase();
  const refresh=useCallback(async():Promise<void>=>{
    try{const result=await api<WorktreeInventory>(path);if(apiBase()===machineBase){setInventory(result);setLoadedBase(machineBase);setLoadError(null);}}
    catch(cause){if(apiBase()===machineBase)setLoadError(cause instanceof Error?cause.message:String(cause));}
  },[path,machineBase]);
  useEffect(()=>{
    setInventory(null);setLoadedBase(null);setConfirmation(null);setCommitting(null);setReviewed(null);setError(null);setLoadError(null);setBusy(null);setExpanded(new Set());
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
  const chooseTarget=async(view:WorktreeView,branch:string):Promise<void>=>{
    if(apiBase()!==machineBase)return;
    setBusy(view.id);setError(null);
    try{await api(`/api/worktrees/${view.id}/target`,{method:'PATCH',body:JSON.stringify({branch})});if(apiBase()===machineBase)await refresh();}
    catch(cause){if(apiBase()===machineBase)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(apiBase()===machineBase)setBusy(null);}
  };
  const toggle=(id:string):void=>setExpanded(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next;});
  const visibleInventory=loadedBase===machineBase?inventory:null;
  const copies=visibleInventory?.worktrees.filter(view=>view.managed&&!view.primary)??[];
  const other=visibleInventory?.worktrees.filter(view=>!view.managed||view.primary)??[];
  if(projectId&&workspaceMode==='shared'&&visibleInventory&&copies.length===0&&other.every(view=>view.primary)&&!loadError&&!error&&!visibleInventory.errors.length)return null;
  return <section className="card worktrees-panel" aria-label="Copies de travail des conversations">
    <div className="worktrees-heading"><h2>Copies de travail <span className="pill">{visibleInventory?copies.length:'…'}</span></h2>
      <button type="button" className="btn" onClick={()=>void refresh()}>Actualiser</button>
    </div>
    <p className="worktrees-explanation">{workspaceMode==='shared'?'Ce projet utilise directement son dossier. Ses anciennes copies isolées restent accessibles ici.':'Les copies isolent le travail des conversations. Pour récupérer leur travail : créer le commit, puis l’intégrer au projet. Supprimer une conversation conserve sa copie ici.'}</p>
    {loadError?<p className="form-error" role="alert">{loadError}</p>:null}
    {error?<p className="form-error" role="alert">{error}</p>:null}
    {visibleInventory?.errors.map(message=><p className="form-error" key={message}>{message}</p>)}
    {visibleInventory&&copies.length===0?<p className="empty-hint">Aucune copie de conversation à traiter.</p>:null}
    <ul className="worktree-list">
      {copies.map(view=>{
        const operationBusy=view.operation?.status==='running';const disabled=busy!==null||operationBusy;
        const showDetails=expanded.has(view.id);const changes=view.changesSinceCreation;
        const initialOnly=changes?.count===0&&view.ahead===0&&!!view.dirty;
        const needsReview=!!changes?.needsReviewCount||!changes;
        const changedCount=changes?.count??view.dirty;
        const commitBlocked=disabled||!!view.error||view.activeSessions.some(session=>session.status!=='idle');
        return <li className="worktree-row" key={view.id}>
          <div className="worktree-overview">
            <div className="worktree-identity">
              <div className="worktree-title">
                <strong title={copyTitle(view)}>{view.session?<a href={href(`#/s/${view.session.id}`)}>{copyTitle(view)}</a>:copyTitle(view)}</strong>
                <span className={`pill ${!initialOnly&&(view.ahead||changes?.count)?'worktree-pending':''}`}>{copyStatus(view)}</span>
              </div>
              <div className="worktree-meta">
                {!projectId?<span className="worktree-context">{view.projectName}{view.projectExists?'':' (projet retiré)'}</span>:null}
                <span>{view.session?'Conversation conservée':view.sessionTitle?'Conversation supprimée':'Titre d’origine indisponible'}</span>
                <span className="worktree-destination">Cible : {branchName(view.targetBranch)}</span>
              </div>
              {initialOnly?<p className="worktree-guidance">Aucun nouveau changement depuis sa création. Les fichiers modifiés proviennent de la copie de départ.</p>
                :needsReview&&view.dirty?<p className="worktree-guidance">Examinez les changements avant de les enregistrer : certains existaient déjà dans le projet à la création de cette copie. Dans les diffs, cochez les fichiers examinés pour les commiter.</p>
                :view.dirty?<p className="worktree-guidance">Créez le commit pour pouvoir ensuite l’intégrer au projet.</p>
                :view.ahead&&view.mergeBlockers.length?<p className="worktree-guidance">L’intégration est bloquée. Les détails indiquent ce qu’il faut résoudre.</p>:null}
            </div>
            <div className="worktree-counts">
              {!initialOnly?<span title={changes?'Fichiers modifiés depuis la création de la copie ; ce compteur n’attribue pas leur auteur.':'Modifications locales dont l’origine n’est pas connue.'}>{changedCount??'?'} fichier{changedCount===1?'':'s'} {changes?`modifié${changedCount===1?'':'s'}`:'à examiner'}</span>:null}
              {view.ahead?<span>{view.ahead} commit{view.ahead===1?'':'s'} à intégrer</span>:null}
            </div>
            <div className="worktree-actions">
              {!initialOnly&&!!view.dirty?(needsReview?<button type="button" className="btn" onClick={()=>toggle(view.id)}>Examiner</button>:<button type="button" className="btn" disabled={commitBlocked} onClick={()=>setCommitting(view)}>Créer le commit</button>):null}
              {!view.dirty&&!!view.ahead?<button type="button" className="btn" disabled={disabled||view.mergeBlockers.length>0} title={view.mergeBlockers.join('\n')} onClick={()=>void prepare(view,'merge')}>Intégrer au projet</button>:null}
              <button type="button" className="btn worktree-toggle" aria-expanded={showDetails} aria-controls={`worktree-details-${view.id}`} onClick={()=>toggle(view.id)}>{showDetails?'Réduire':'Détails'}</button>
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
            {changes?.inheritedCount?<p>{changes.inheritedCount} fichier(s) ont encore le contenu copié du projet au départ. Ils ne représentent pas du nouveau travail dans cette copie.</p>:null}
            {changes?.count?<><p>Fichiers modifiés depuis la création{changes.count>changes.files.length?' (100 premiers)':''} :</p><pre>{changes.files.join('\n')}</pre></>:null}
            {changes?.needsReviewCount?<p>{changes.needsReviewCount} de ces fichiers étaient déjà modifiés au départ. Leurs changements doivent être examinés ; ils ne sont pas attribués automatiquement à la conversation.</p>:null}
            {showDetails&&!initialOnly&&!!view.dirty?<WorktreeDiffs view={view} onCommitReviewed={commitBlocked?undefined:value=>{setReviewed(value);setCommitting(view);}}/>:null}
            {!initialOnly&&!!view.dirty&&needsReview?<button type="button" className="btn" disabled={commitBlocked} title="Crée les commits uniquement pour les fichiers dont la sélection automatique est vérifiable. Les autres restent dans la copie." onClick={()=>setCommitting(view)}>Commiter les fichiers vérifiables</button>:null}
            <div className="worktree-target"><label>Intégrer dans <select aria-label={`Cible de ${copyTitle(view)}`} value={view.targetBranch??''} disabled={disabled} onChange={event=>void chooseTarget(view,event.target.value)}>
              {!view.targets.some(target=>target.branch===view.targetBranch)?<option value={view.targetBranch??''}>{view.targetBranch?`${branchName(view.targetBranch)} (dossier non ouvert)`:'Choisir une branche'}</option>:null}
              {view.targets.map(target=><option key={target.branch} value={target.branch}>{branchName(target.branch)} — {target.path}</option>)}
            </select></label></div>
            {view.mergeBlockers.length&&!initialOnly?<><p>Pour intégrer cette copie :</p><ul>{view.mergeBlockers.map(reason=><li key={reason}>{reason}</li>)}</ul></>:null}
            {view.operation?.output?<details><summary>Résultat Git</summary><pre>{view.operation.output}</pre></details>:null}
            <details className="worktree-cleanup"><summary>Retirer cette copie</summary>
              <p>Le retrait est distinct de la suppression de la conversation. Il est disponible uniquement quand les changements sont intégrés et qu’aucune donnée locale ne risque d’être effacée.</p>
              {view.ignored?<p>{view.ignored} fichier(s) ignoré(s) par Git sont présents (par exemple dépendances ou configuration locale). Ce ne sont pas des changements à intégrer ; ils sont conservés et empêchent le retrait de la copie.</p>:null}
              {view.removeBlockers.length?<ul>{view.removeBlockers.map(reason=><li key={reason}>{reason}</li>)}</ul>:null}
              <button type="button" className="btn danger-ghost" disabled={disabled||view.removeBlockers.length>0} onClick={()=>void prepare(view,'remove')}>Retirer la copie</button>
            </details>
          </div>
        </li>;
      })}
    </ul>
    {other.length?<details className="worktrees-other"><summary>Dossier principal et autres copies Git ({other.length})</summary>
      <p className="meta">Le dossier principal se traite avec « Commit / push du projet ». Les copies non associées restent visibles ici pour retrouver leur contenu.</p>
      {other.map(view=><details className="worktree-other" key={view.id}><summary>{view.primary?'Dossier principal du projet':'Copie sans conversation identifiée'}{!projectId?` · ${view.projectName}`:''} · {view.dirty??'?'} fichier(s) modifié(s)</summary>
        <p className="path">{view.path}</p><p className="meta">Branche : {branchName(view.branch??view.expectedBranch)}</p>
        <p>{view.primary?'C’est le dossier utilisé par le projet et les conversations historiques. Il n’a pas à être intégré dans lui-même.':'Les données de création de cette copie ne sont pas disponibles. Cerebro ne peut ni attribuer son contenu à une conversation, ni la retirer automatiquement.'}</p>
        {view.error?<p className="form-error">{view.error}</p>:null}
        {!view.primary?<WorktreeDiffs view={view}/>:null}
        {view.primary&&view.projectExists&&view.projectId?<button type="button" className="btn" onClick={()=>setCommitting(view)}>Commit / push du projet</button>:null}
      </details>)}
    </details>:null}
    {confirmation&&confirmation.machineBase===machineBase?<Modal title={confirmation.kind==='merge'?'Intégrer le travail au projet':'Retirer la copie de travail'} onClose={()=>setConfirmation(null)}>
      <p>{copyTitle(confirmation.view)}</p><p>Copie : {confirmation.view.path}</p><p>Projet cible : {confirmation.view.targetPath} · {branchName(confirmation.view.targetBranch)}</p>
      {confirmation.kind==='merge'?<><p>Les commits de cette copie seront intégrés au projet. Les contrôles Git habituels s’appliquent. En cas de conflit, les fichiers resteront à résoudre dans le dossier cible.</p><p>La conversation peut continuer dans sa copie. Ses nouveaux changements pourront être intégrés ensuite.</p></>:<p>La copie propre et intégrée sera retirée. Sa branche, ses commits et la conversation seront conservés. Cette conversation ne pourra plus reprendre dans la copie supprimée.</p>}
      {error?<p className="form-error" role="alert">{error}</p>:null}
      <div className="row-actions"><button type="button" className={`btn ${confirmation.kind==='remove'?'danger-ghost':'primary'}`} disabled={busy!==null} onClick={()=>void run()}>{confirmation.kind==='merge'?'Intégrer au projet':'Retirer la copie'}</button><button type="button" className="btn" disabled={busy!==null} onClick={()=>setConfirmation(null)}>Annuler</button></div>
    </Modal>:null}
    {committing&&loadedBase===machineBase?<AutomaticCommitDialog projectId={committing.projectId??''} reviewed={reviewed??undefined} endpoint={committing.primary?undefined:`/api/worktrees/${committing.id}/git`} push={committing.primary} scopeLabel={committing.primary?'Tous les changements du dossier partagé du projet':`Fichiers vérifiables de la copie · ${copyTitle(committing)}`} onClose={()=>{setCommitting(null);setReviewed(null);void refresh();}}/>:null}
  </section>;
}
