import { ActivityStatus } from './ActivityStatus.tsx';
import { useState } from 'react';
import { Modal } from './Dialog.tsx';
import { useStore } from './store.tsx';
import { LlmSelector, type LlmSelection } from './LlmSelector.tsx';
import type { Project } from './types.ts';
import './automatic-commits.css';

export function CommitSettingsDialog({project,onClose}:{project:Project;onClose:()=>void}) {
  const {agents,updateProject}=useStore();
  const [settings,setSettings]=useState<LlmSelection>(()=>{
    const {agent,model,effort}=project.commitSettings;
    return {agent,model,effort};
  });
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const save=async():Promise<void>=>{
    setBusy(true);setError(null);
    try{await updateProject(project.id,{commitSettings:settings});onClose();}
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{setBusy(false);}
  };
  return <Modal title="Réglages LLM" onClose={onClose}>
    <form className="commit-settings" onSubmit={event=>{event.preventDefault();void save();}}>
      <p>« Commit / push » utilise ces réglages pour préparer les messages, puis crée et pousse les commits automatiquement.</p>
      <LlmSelector agents={agents} value={settings} defaults={project.commitSettings} disabled={busy} onChange={setSettings}/>
      <p className="hint">Ces réglages sont propres à ce projet et indépendants de ceux des sessions.</p>
      {error?<p className="form-error" role="alert">{error}</p>:null}
      <div className="row-actions"><button type="submit" className="btn primary" disabled={busy}><ActivityStatus active={busy}>{busy?'Enregistrement…':'Enregistrer'}</ActivityStatus></button><button type="button" className="btn" disabled={busy} onClick={onClose}>Annuler</button></div>
    </form>
  </Modal>;
}
