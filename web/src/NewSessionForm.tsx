import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { clipboardImage, uploadProjectImage } from './api.ts';
import { AttachmentStrip, insertToken, removeToken, restoredAttachment, useImageAttachments } from './attachments.tsx';
import { ChoiceGroup } from './ChoiceGroup.tsx';
import { readDraft, writeDraft } from './drafts.ts';
import { AGENT_LABEL, MODE_CHIP } from './format.ts';
import { useStore } from './store.tsx';
import { DEFAULT_SESSION_DEFAULTS, MODES, type Agent, type Effort, type LaunchSpec, type Mode } from './types.ts';
import { isSubmitShortcut, SUBMIT_HINT } from './keys.ts';

// Agent, mode, modèle, effort et prompt d'une nouvelle session : page projet, et modales lancées depuis une
// sélection du terminal ou une tâche du backlog.
export function NewSessionForm({
  projectId,
  draftKey,
  initialPrompt,
  promptFor,
  heading,
  submitLabel = 'Lancer',
  launchDisabled = false,
  autoFocus = false,
  className = '',
  onLaunch,
  onCancel,
}: {
  projectId: string;
  // Clé de brouillon : le prompt non lancé est conservé dans le navigateur. [SPEC UI web › Vue projet]
  draftKey?: string;
  initialPrompt?: string;
  // Prompt prérempli propre à l'agent choisi ; remplace initialPrompt tant que l'utilisateur ne l'a pas modifié.
  promptFor?: (agent: Agent) => string;
  heading?: string;
  submitLabel?: string;
  launchDisabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  onLaunch: (spec: LaunchSpec) => Promise<void>;
  onCancel?: () => void;
}) {
  const { agents, projects, updateProject } = useStore();
  const defaults = projects.find((p) => p.id === projectId)?.sessionDefaults ?? DEFAULT_SESSION_DEFAULTS;
  const available = agents.filter((a) => a.available);
  const [agent, setAgent] = useState<Agent>(defaults.agent);
  const [mode, setMode] = useState<Mode>(defaults.mode);
  // null : défaut de la configuration de l'agent.
  const [model, setModel] = useState<string | null>(defaults.model);
  const [effort, setEffort] = useState<Effort | null>(defaults.effort);
  const [draft] = useState(() => (draftKey === undefined ? null : readDraft(draftKey)));
  const [prompt, setPrompt] = useState(() => draft?.prompt ?? promptFor?.(agent) ?? initialPrompt ?? defaults.prompt);
  const [promptEdited, setPromptEdited] = useState(draft !== null);
  const generatedRef = useRef(prompt);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [savingDefaults, setSavingDefaults] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const queuedPrompt = useRef<string | null>(null);
  const images = useImageAttachments(
    (image) => uploadProjectImage(projectId, image),
    draft?.images.map((i) => restoredAttachment(i.n, i.token, i.path)),
  );

  // Sérialiser les modifications rapides évite qu'une réponse ancienne remplace le dernier choix.
  const saveDefaults = useCallback((patch: Partial<LaunchSpec>): void => {
    if (patch.prompt !== undefined) queuedPrompt.current = patch.prompt;
    setSavingDefaults((count) => count + 1);
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        await updateProject(projectId, { sessionDefaults: patch });
        setDefaultsError(null);
      } catch (err) {
        setDefaultsError(err instanceof Error ? err.message : 'Enregistrement impossible');
      } finally {
        setSavingDefaults((count) => count - 1);
      }
    });
  }, [projectId, updateProject]);

  const expandedPrompt = images.expand(prompt);
  useEffect(() => {
    if (!promptEdited || images.pending || busy || expandedPrompt === queuedPrompt.current) return;
    const timer = setTimeout(() => saveDefaults({ prompt: expandedPrompt }), 400);
    return () => clearTimeout(timer);
  }, [promptEdited, images.pending, busy, expandedPrompt, saveDefaults]);

  useEffect(() => {
    if (draftKey === undefined) return;
    const uploaded = images.items.flatMap((i) => (i.path === null ? [] : [{ n: i.n, token: i.token, path: i.path }]));
    setDraftError(writeDraft(draftKey, { prompt: promptEdited ? prompt : '', images: uploaded }));
  }, [draftKey, prompt, promptEdited, images.items]);

  useEffect(() => {
    if (!promptEdited && initialPrompt === undefined && promptFor === undefined) setPrompt(defaults.prompt);
  }, [defaults.prompt, initialPrompt, promptFor, promptEdited]);

  const chooseAgent = (next: Agent): void => {
    if (next === agent) return;
    setAgent(next);
    setModel(next === defaults.agent ? defaults.model : null);
    setEffort(next === defaults.agent ? defaults.effort : null);
    saveDefaults({
      agent: next,
      model: next === defaults.agent ? defaults.model : null,
      effort: next === defaults.agent ? defaults.effort : null,
    });
  };

  useEffect(() => {
    if (savingDefaults > 0 || busy) return;
    const list = agents.filter((a) => a.available);
    const next = list.find((a) => a.agent === defaults.agent) ?? list[0];
    if (next === undefined) return;
    const nextModel = next.agent === defaults.agent && next.models.some((m) => m.value === defaults.model) ? defaults.model : null;
    const supported = nextModel === null ? next.efforts : next.models.find((m) => m.value === nextModel)?.efforts ?? [];
    setAgent(next.agent);
    setMode(defaults.mode);
    setModel(nextModel);
    setEffort(next.agent === defaults.agent && defaults.effort !== null && supported.includes(defaults.effort) ? defaults.effort : null);
  }, [agents, defaults.agent, defaults.mode, defaults.model, defaults.effort, savingDefaults, busy]);

  useEffect(() => {
    if (!promptFor) return;
    const next = promptFor(agent);
    // Copie locale : l'updater s'exécute au rendu suivant, après la mise à jour de la ref.
    const previous = generatedRef.current;
    setPrompt((current) => (current === previous ? next : current));
    generatedRef.current = next;
  }, [agent, promptFor]);

  // Modèles proposés selon l'agent, efforts selon le modèle (catalogue découvert par le serveur).
  const info = agents.find((a) => a.agent === agent);
  const models = info?.models ?? [];
  const efforts = (model === null ? info?.efforts : models.find((m) => m.value === model)?.efforts) ?? [];
  useEffect(() => {
    // Le catalogue arrive après les projets : ne pas effacer les réglages pendant son chargement.
    if (info === undefined) return;
    if (model !== null && !models.some((m) => m.value === model)) setModel(null);
    else if (effort !== null && !efforts.includes(effort)) setEffort(null);
  }, [info, models, efforts, model, effort]);

  useEffect(() => {
    setError(null);
  }, [projectId]);

  useEffect(() => {
    if (autoFocus) promptRef.current?.focus();
  }, [autoFocus]);

  // Image collée ou déposée : « [Image #N] » est inséré au curseur, et remplacé par le chemin
  // du fichier au lancement (les agents lisent les images référencées par chemin).
  const attachImage = (image: File): void => {
    setPromptEdited(true);
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
    if (launchDisabled || available.length === 0 || busy || images.pending) return;
    setError(null);
    setBusy(true);
    try {
      await saveQueue.current;
      const spec = { agent, mode, model, effort, prompt: images.expand(prompt) };
      await onLaunch(spec);
      setPrompt(spec.prompt);
      setPromptEdited(false);
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
    if (isSubmitShortcut(e)) {
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
              onChange={chooseAgent}
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
              onChange={(v) => {
                const next = v === '' ? null : v;
                const supported = (next === null ? info?.efforts : models.find((m) => m.value === next)?.efforts) ?? [];
                const nextEffort = effort !== null && supported.includes(effort) ? effort : null;
                setModel(next);
                setEffort(nextEffort);
                saveDefaults({ agent, model: next, effort: nextEffort });
              }}
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
              onChange={(v) => {
                const next = v === '' ? null : v;
                setEffort(next);
                saveDefaults({ agent, model, effort: next });
              }}
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
            onChange={(next) => {
              setMode(next);
              saveDefaults({ mode: next });
            }}
          />
        </div>
      </div>
      {mode === 'bypass' ? (
        <p className="warn-bypass">Mode bypass : permissions et sandbox désactivés.</p>
      ) : null}
      <label className="block">
        Prompt
        <textarea
          rows={initialPrompt === undefined || initialPrompt === '' ? 5 : 10}
          value={prompt}
          onChange={(e) => {
            setPromptEdited(true);
            setPrompt(e.target.value);
            images.prune(e.target.value);
          }}
          onBlur={() => {
            if (promptEdited && !images.pending && expandedPrompt !== queuedPrompt.current) saveDefaults({ prompt: expandedPrompt });
          }}
          onKeyDown={onKeyDown}
          onPaste={onPromptPaste}
          onDrop={onPromptDrop}
          ref={promptRef}
          placeholder={`${SUBMIT_HINT} pour lancer · Ctrl+V ou glisser-déposer pour joindre une image`}
        />
        <AttachmentStrip
          items={images.items}
          onRemove={(item) => {
            setPromptEdited(true);
            images.remove(item.n);
            setPrompt((current) => removeToken(current, item.token));
          }}
        />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      {draftError ? <p className="form-error">Brouillon non sauvegardé : {draftError}</p> : null}
      {defaultsError ? <p className="form-error">Réglages non sauvegardés : {defaultsError}</p> : null}
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={launchDisabled || busy || images.pending || available.length === 0}>
          {submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="btn" onClick={onCancel}>
            Annuler
          </button>
        ) : null}
        <span className="hint">{SUBMIT_HINT}</span>
        {draftKey !== undefined && promptEdited && prompt.trim() !== '' && draftError === null ? (
          <span className="hint" title="Le prompt est conservé dans ce navigateur jusqu'au lancement">
            Brouillon enregistré
          </span>
        ) : null}
      </div>
    </form>
  );
}
