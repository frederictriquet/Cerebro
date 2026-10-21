import { useEffect, useRef, useState } from 'react';
import { api, apiBase } from './api.ts';
import { Modal } from './Dialog.tsx';
import type { CommitSettings } from './types.ts';
import type { AutomaticCommit } from '../../server/automatic-commits.ts';
import './automatic-commits.css';

const PHASE_LABEL:Record<AutomaticCommit['phase'],string>={collecting:'Vérification des changements…',drafting:'Rédaction du message par l’IA…',committing:'Création du commit…',pushing:'Push vers les remotes…',finished:'Terminé'};
interface CommitDialogProps {projectId:string;endpoint?:string;push?:boolean;strategy?:CommitSettings['strategy'];onClose:()=>void;scopeLabel?:string;reviewed?:{snapshotId:string;paths:string[]}}
export function AutomaticCommitDialog(props:CommitDialogProps) {
  const [useProject,setUseProject]=useState(false);
  return <AutomaticCommitRun key={useProject?'project':'initial'} {...props} endpoint={useProject?undefined:props.endpoint}
    reviewed={useProject?undefined:props.reviewed} scopeLabel={useProject?'Tous les changements du dossier partagé du projet':props.scopeLabel} onUseProject={()=>setUseProject(true)}/>;
}
function AutomaticCommitRun({projectId,endpoint,push=true,strategy,onClose,scopeLabel,reviewed,onUseProject}:CommitDialogProps&{onUseProject:()=>void}) {
  const [requestId]=useState(()=>crypto.randomUUID());
  const [review]=useState(reviewed);
  const [machineBase]=useState(apiBase);
  const [operation,setOperation]=useState<AutomaticCommit|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [cancelling,setCancelling]=useState(false);
  const [openedAt]=useState(Date.now);
  const [now,setNow]=useState(Date.now);
  const start=useRef<Promise<AutomaticCommit>|null>(null);
  const path=endpoint??`/api/projects/${projectId}/git`;
  useEffect(()=>{
    let disposed=false;
    const show=(value:AutomaticCommit):void=>{
      if(disposed||apiBase()!==machineBase)return;
      setOperation(value);setError(null);
      if(value.finishedAt)void api(`/api/operations/${encodeURIComponent(`auto-commit:${value.id}`)}/seen`,{method:'POST'}).catch(()=>{});
    };
    if(apiBase()!==machineBase)return;
    // Reuse the same request in React StrictMode. Reopening also attaches to an active server operation.
    start.current??=api<AutomaticCommit>(`${path}/auto-commit`,{method:'POST',body:JSON.stringify({requestId,push,strategy,...(review?{reviewed:review}:{})})});
    let id:string|null=null;
    void start.current.then(value=>{id=value.id;show(value);}).catch(cause=>{if(!disposed&&apiBase()===machineBase)setError(cause instanceof Error?cause.message:String(cause));});
    let timer:number|undefined;
    const poll=async():Promise<void>=>{
      if(disposed||apiBase()!==machineBase)return;
      if(id)try{
        const value=await api<AutomaticCommit>(`/api/git/auto-commits/${id}`);
        show(value);
        if(value.finishedAt)return;
      }catch(cause){if(!disposed&&apiBase()===machineBase)setError(cause instanceof Error?cause.message:String(cause));}
      if(!disposed)timer=window.setTimeout(()=>void poll(),300);
    };
    void poll();
    return()=>{disposed=true;window.clearTimeout(timer);};
  },[path,requestId,push,strategy,review,machineBase]);
  const cancel=async():Promise<void>=>{
    if(!operation||apiBase()!==machineBase)return;
    setCancelling(true);
    try{await api(`/api/git/auto-commits/${operation.id}/cancel`,{method:'POST'});}
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{setCancelling(false);}
  };
  const active=operation?operation.status==='running':!error;
  useEffect(()=>{
    if(!active)return;
    const timer=window.setInterval(()=>setNow(Date.now()),1000);
    return()=>window.clearInterval(timer);
  },[active]);
  const phase=operation?.phase??'collecting';
  const steps=[['collecting','Vérifier les fichiers'],['drafting','Rédiger le message'],['committing','Créer le commit'],...(push?[['pushing','Envoyer les commits']]:[])];
  return <Modal title={push?'Commit et push automatiques':'Commit automatique'} onClose={onClose}>
    <div className="automatic-commit">
      <p className="automatic-commit-status" role="status">
        {operation?.status==='succeeded'?(operation.push?(operation.commits.length?'Commit et push terminés.':'Push terminé.'):operation.commits.length?'Commit créé.':'Aucun changement à commiter.')
          :operation?.needsProjectScope?'Cette conversation utilise le dossier partagé du projet.':operation?.status==='cancelled'?'Opération annulée.':operation&&operation.status!=='running'?'L’opération s’est arrêtée.':PHASE_LABEL[operation?.phase??'collecting']}
      </p>
      {active?<div className="automatic-commit-progress">
        <ol aria-label="Étapes de l’opération">{steps.map(([key,label])=><li key={key} aria-current={phase===key?'step':undefined} className={phase===key?'current':undefined}>{label}</li>)}</ol>
        <p className="meta">{Math.max(0,Math.floor((now-(operation?.startedAt??openedAt))/1000))} s écoulées</p>
        <p>{phase==='collecting'?'Lecture des changements Git en cours.':phase==='drafting'?'L’IA analyse les changements pour rédiger le message. Cette étape peut prendre du temps ; aucun commit n’a encore été créé.':phase==='committing'?'Git enregistre les changements. Cette étape ne peut plus être annulée.':'Git envoie les commits aux dépôts distants. Cette étape ne peut plus être annulée.'}</p>
        {operation?.files.length?<p className="meta">{operation.files.length} fichier(s) à commiter</p>:null}
      </div>:null}
      <p className="meta">{scopeLabel??(endpoint?'Changements de cette copie de travail':'Changements du projet')}{operation?.path?` · ${operation.path}`:''}</p>
      {operation&&operation.phase==='drafting'?<p className="meta">{operation.settings.agent} · {operation.settings.model??'modèle par défaut'} · effort {operation.settings.effort??'par défaut'}</p>:null}
      {operation?.commits.map(commit=><p className="automatic-commit-result" key={commit.hash}><code>{commit.hash.slice(0,8)}</code> {commit.title}</p>)}
      {operation?.needsProjectScope?<p>Ses changements ne peuvent pas être séparés de ceux des autres conversations. Vous pouvez commiter et pousser les changements du projet entier depuis ici.</p>:operation?.error?<p className="form-error" role="alert">{operation.error}</p>:null}
      {error?<p className="form-error" role="alert">{error}</p>:null}
      {operation?.pushOperation?.remotes.map(remote=><p className={remote.status==='failed'?'form-error':'meta'} key={remote.remote}>{remote.remote} : {({pending:'en attente',running:'push en cours…',succeeded:'envoyé',failed:'échec'})[remote.status]}</p>)}
      {!operation?.needsProjectScope&&operation?.exclusions.length?<details><summary>{operation.exclusions.length} fichier(s) écarté(s), conservé(s) dans le dépôt</summary><ul>{operation.exclusions.map(file=><li key={file.path}><code>{file.path}</code> — {file.reason}</li>)}</ul></details>:null}
      {operation?.files.length||operation?.pushOperation?<details><summary>Détails de l’opération</summary>
        <p className="path">{operation.path}</p>
        {operation.files.length?<pre>{operation.files.join('\n')}</pre>:null}
        {operation.pushOperation?.remotes.map(remote=><div key={remote.remote}><strong>{remote.remote}</strong><pre>{remote.output}</pre></div>)}
      </details>:null}
      <div className="row-actions">
        {operation?.needsProjectScope&&projectId?<button type="button" className="btn primary" onClick={onUseProject}>{push?'Commiter et pousser tout le projet':'Commiter tout le projet'}</button>:null}
        <button type="button" className="btn" onClick={onClose}>{active?'Continuer en arrière-plan':'Fermer'}</button>
        {active&&!error?<span className="hint">Ce bouton masque la fenêtre sans arrêter l’opération.</span>:null}
        {operation?.status==='running'&&['collecting','drafting'].includes(operation.phase)?<button type="button" className="btn automatic-commit-cancel" disabled={cancelling} onClick={()=>void cancel()}>{cancelling?'Annulation…':'Annuler l’opération'}</button>:null}
      </div>
    </div>
  </Modal>;
}
