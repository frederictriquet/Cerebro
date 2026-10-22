import { ActivityStatus } from './ActivityStatus.tsx';
import { useState } from 'react';
import { Modal } from './Dialog.tsx';
import { useStore } from './store.tsx';
import { LlmSelector, type LlmSelection } from './LlmSelector.tsx';
import { ChoiceGroup } from './ChoiceGroup.tsx';
import { MODE_CHIP, MODE_DESCRIPTION } from './format.ts';
import { MODES, type Project, type ResolutionSettings } from './types.ts';
import './automatic-commits.css';

export function CommitSettingsDialog({project,onClose}:{project:Project;onClose:()=>void}) {
  const {agents,updateProject}=useStore();
  const [settings,setSettings]=useState<LlmSelection>(()=>{
    const {agent,model,effort}=project.commitSettings;
    return {agent,model,effort};
  });
  const [resolution,setResolution]=useState<ResolutionSettings>(()=>({...project.resolutionSettings}));
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const save=async():Promise<void>=>{
    setBusy(true);setError(null);
    try{await updateProject(project.id,{commitSettings:settings,resolutionSettings:resolution});onClose();}
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{setBusy(false);}
  };
  return <Modal title="Réglages LLM" onClose={onClose}>
    <form className="commit-settings" onSubmit={event=>{event.preventDefault();void save();}}>
      <section className="commit-settings-section" aria-labelledby="commit-settings-commits">
        <h3 id="commit-settings-commits">Commits</h3>
        <p>« Commit / push » utilise ces réglages pour préparer les messages, puis crée et pousse les commits automatiquement.</p>
        <LlmSelector agents={agents} value={settings} defaults={project.commitSettings} disabled={busy} onChange={setSettings}/>
      </section>
      <section className="commit-settings-section" aria-labelledby="commit-settings-resolution">
        <h3 id="commit-settings-resolution">Résolution des fichiers à examiner</h3>
        <p>« Résoudre avec l’IA » lance une session dans la copie de travail pour séparer le contenu de départ du travail de la conversation, sur les fichiers que le retrait automatique laisse à examiner.</p>
        <LlmSelector agents={agents} value={resolution} defaults={project.resolutionSettings} disabled={busy} onChange={selection=>setResolution(current=>({...current,...selection}))}>
          <div className="tuning">
            <span className="field-label">Mode</span>
            <ChoiceGroup compact label="Mode de la session de résolution" value={resolution.mode} disabled={busy}
              options={MODES.map(mode=>({value:mode,label:MODE_CHIP[mode],title:MODE_DESCRIPTION[mode],danger:mode==='bypass'}))}
              onChange={mode=>setResolution(current=>({...current,mode}))}/>
          </div>
        </LlmSelector>
        {resolution.mode==='plan'?<p className="commit-settings-warning">En mode plan, la session ne peut pas modifier les fichiers : elle proposera seulement la résolution.</p>:null}
      </section>
      <p className="hint">Ces réglages sont propres à ce projet et indépendants de ceux des sessions.</p>
      {error?<p className="form-error" role="alert">{error}</p>:null}
      <div className="row-actions"><button type="submit" className="btn primary" disabled={busy}><ActivityStatus active={busy}>{busy?'Enregistrement…':'Enregistrer'}</ActivityStatus></button><button type="button" className="btn" disabled={busy} onClick={onClose}>Annuler</button></div>
    </form>
  </Modal>;
}
