import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { clipboardImage, uploadProjectImage } from './api.ts';
import { AttachmentStrip, insertToken, removeToken, useImageAttachments } from './attachments.tsx';
import { ChoiceGroup } from './ChoiceGroup.tsx';
import { AGENT_LABEL, MODE_CHIP } from './format.ts';
import { useStore } from './store.tsx';
import { MODES, type Agent, type Effort, type LaunchSpec, type Mode } from './types.ts';

// Agent, mode, modèle, effort et prompt d'une nouvelle session : page projet, et modales lancées depuis une
// sélection du terminal ou une tâche du backlog.
export function NewSessionForm({
  projectId,
  initialPrompt = '',
  heading,
  submitLabel = 'Lancer',
  autoFocus = false,
  className = '',
  onLaunch,
  onCancel,
}: {
  projectId: string;
  initialPrompt?: string;
  heading?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  className?: string;
  onLaunch: (spec: LaunchSpec) => Promise<void>;
  onCancel?: () => void;
}) {
  const { agents } = useStore();
  const available = agents.filter((a) => a.available);
  const [agent, setAgent] = useState<Agent>('claude');
  const [mode, setMode] = useState<Mode>('auto');
  // null : défaut de la configuration de l'agent.
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort | null>(null);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const images = useImageAttachments((image) => uploadProjectImage(projectId, image));

  useEffect(() => {
    const list = agents.filter((a) => a.available);
    if (list.some((a) => a.agent === agent)) return;
    const first = list[0];
    if (first) setAgent(first.agent);
  }, [agents, agent]);

  // Modèles proposés selon l'agent, efforts selon le modèle (catalogue découvert par le serveur).
  const info = agents.find((a) => a.agent === agent);
  const models = info?.models ?? [];
  const efforts = (model === null ? info?.efforts : models.find((m) => m.value === model)?.efforts) ?? [];
  useEffect(() => {
    if (model !== null && !models.some((m) => m.value === model)) setModel(null);
    else if (effort !== null && !efforts.includes(effort)) setEffort(null);
  }, [models, efforts, model, effort]);

  useEffect(() => {
    setError(null);
  }, [projectId]);

  useEffect(() => {
    if (autoFocus) promptRef.current?.focus();
  }, [autoFocus]);

  // Image collée ou déposée : « [Image #N] » est inséré au curseur, et remplacé par le chemin
  // du fichier au lancement (les agents lisent les images référencées par chemin).
  const attachImage = (image: File): void => {
    const el = promptRef.current;
    const start = el?.selectionStart ?? prompt.length;
    const end = el?.selectionEnd ?? prompt.length;
    const token = images.add(image, (failed, message) => {
      setPrompt((current) => removeToken(current, failed));
      setError(`Image non envoyée : ${message}`);
    });
    setPrompt((current) => insertToken(current, start, end, token));
  };
  const onPromptPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const image = clipboardImage(event.clipboardData);
    if (image === null) return;
    event.preventDefault();
    attachImage(image);
  };
  const onPromptDrop = (event: DragEvent<HTMLTextAreaElement>): void => {
    const image = clipboardImage(event.dataTransfer);
    if (image === null) return;
    event.preventDefault();
    attachImage(image);
  };

  const launch = async (): Promise<void> => {
    if (available.length === 0 || busy || images.pending) return;
    setError(null);
    setBusy(true);
    try {
      await onLaunch({ agent, mode, model, effort, prompt: images.expand(prompt) });
      setPrompt('');
      images.reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lancement impossible');
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    void launch();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      void launch();
    }
  };

  return (
    <form className={`card new-session ${className}`.trim()} onSubmit={onSubmit}>
      {heading ? <h2>{heading}</h2> : null}
      <div className="tuning-row">
        <div className="tuning">
          <span className="field-label">Agent</span>
          {available.length === 0 ? (
            <span className="muted">Aucun agent disponible</span>
          ) : (
            <ChoiceGroup
              compact
              label="Agent"
              value={agent}
              options={available.map((a) => ({ value: a.agent, label: AGENT_LABEL[a.agent] }))}
              onChange={setAgent}
            />
          )}
        </div>
        {models.length > 0 ? (
          <div className="tuning">
            <span className="field-label">Modèle</span>
            <ChoiceGroup
              compact
              label="Modèle"
              value={model ?? ''}
              options={[
                { value: '', label: 'défaut', title: "Modèle configuré pour l'agent" },
                ...models.map((m) => ({ value: m.value, label: m.label, title: m.description || undefined })),
              ]}
              onChange={(v) => setModel(v === '' ? null : v)}
            />
          </div>
        ) : null}
        {efforts.length > 0 ? (
          <div className="tuning">
            <span className="field-label">Effort</span>
            <ChoiceGroup<Effort | ''>
              compact
              label="Effort"
              value={effort ?? ''}
              options={[
                { value: '', label: 'défaut', title: "Effort configuré pour l'agent" },
                ...efforts.map((e) => ({ value: e, label: e })),
              ]}
              onChange={(v) => setEffort(v === '' ? null : v)}
            />
          </div>
        ) : null}
        <div className="tuning">
          <span className="field-label">Mode</span>
          <ChoiceGroup
            compact
            label="Mode"
            value={mode}
            options={MODES.map((m) => ({ value: m, label: MODE_CHIP[m], danger: m === 'bypass' }))}
            onChange={setMode}
          />
        </div>
      </div>
      {mode === 'bypass' ? (
        <p className="warn-bypass">Mode bypass : permissions et sandbox désactivés.</p>
      ) : null}
      <label className="block">
        Prompt
        <textarea
          rows={initialPrompt === '' ? 5 : 10}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
            images.prune(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPromptPaste}
          onDrop={onPromptDrop}
          ref={promptRef}
          placeholder="Ctrl+Entrée pour lancer · Ctrl+V ou glisser-déposer pour joindre une image"
        />
        <AttachmentStrip
          items={images.items}
          onRemove={(item) => {
            images.remove(item.n);
            setPrompt((current) => removeToken(current, item.token));
          }}
        />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={busy || images.pending || available.length === 0}>
          {submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="btn" onClick={onCancel}>
            Annuler
          </button>
        ) : null}
        <span className="hint">Ctrl+Entrée</span>
      </div>
    </form>
  );
}
