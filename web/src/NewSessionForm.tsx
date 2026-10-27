import { ActivityStatus } from './ActivityStatus.tsx';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { uploadProjectImage } from './api.ts';
import { AttachmentStrip, restoredAttachment, useAttachedField } from './attachments.tsx';
import { ChoiceGroup } from './ChoiceGroup.tsx';
import { LlmSelector, llmChoices } from './LlmSelector.tsx';
import { readDraft, writeDraft } from './drafts.ts';
import { errorMessage, MODE_CHIP, MODE_DESCRIPTION, WORKSPACE_TARGET } from './format.ts';
import { useStore } from './store.tsx';
import {
  DEFAULT_SESSION_DEFAULTS,
  MODE_CHOICES,
  normalizeMode,
  type Agent,
  type Effort,
  type Mode,
  type SessionDefaults,
} from '../../shared/types.ts';
import { isSubmitShortcut, SUBMIT_HINT } from './keys.ts';

// Agent, mode, modèle, effort et prompt d'une nouvelle session : page projet, et modales lancées depuis une
// sélection du terminal ou une tâche du backlog.
export function NewSessionForm({
  projectId,
  draftKey,
  initialPrompt,
  promptFor,
  heading,
  submitLabel,
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
  onLaunch: (spec: SessionDefaults) => Promise<void>;
  onCancel?: () => void;
}) {
  const { agents, projects, updateProject } = useStore();
  const project=projects.find((p) => p.id === projectId);
  const launchLabel = submitLabel ?? `Lancer ${WORKSPACE_TARGET[project?.workspaceMode ?? 'isolated']}`;
  const defaults = project?.sessionDefaults ?? DEFAULT_SESSION_DEFAULTS;
  const available = agents.filter((a) => a.available);
  const [agent, setAgent] = useState<Agent>(defaults.agent);
  const [mode, setMode] = useState<Mode>(normalizeMode(defaults.mode));
  // null : default model of the agent, resolved as shown by LlmSelector and launched by parseTuning.
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
  // Seul le formulaire « Nouvelle session » du projet (sans prompt prérempli) mémorise son prompt :
  // celui d'une modale (tâche, sélection, review) ne doit ni remplacer ni effacer ce défaut.
  const remembersPrompt = initialPrompt === undefined && promptFor === undefined;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Image collée ou déposée : « [Image #N] » est inséré au curseur, et remplacé par le chemin
  // du fichier au lancement (les agents lisent les images référencées par chemin).
  const { images, fieldProps, stripProps } = useAttachedField({
    upload: (image) => uploadProjectImage(projectId, image),
    initial: draft?.images.map((i) => restoredAttachment(i.n, i.token, i.path)),
    text: prompt,
    setText: (change) => {
      setPromptEdited(true);
      setPrompt(change);
    },
    onError: (message) => setError(`Image non envoyée : ${message}`),
  });

  // Sérialiser les modifications rapides évite qu'une réponse ancienne remplace le dernier choix.
  const saveDefaults = useCallback((patch: Partial<SessionDefaults>): void => {
    if (patch.prompt !== undefined) queuedPrompt.current = patch.prompt;
    setSavingDefaults((count) => count + 1);
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        await updateProject(projectId, { sessionDefaults: patch });
        setDefaultsError(null);
      } catch (err) {
        setDefaultsError(errorMessage(err, 'Enregistrement impossible'));
      } finally {
        setSavingDefaults((count) => count - 1);
      }
    });
  }, [projectId, updateProject]);

  const expandedPrompt = images.expand(prompt);
  useEffect(() => {
    if (!remembersPrompt || !promptEdited || images.pending || busy || expandedPrompt === queuedPrompt.current) return;
    const timer = setTimeout(() => saveDefaults({ prompt: expandedPrompt }), 400);
    return () => clearTimeout(timer);
  }, [remembersPrompt, promptEdited, images.pending, busy, expandedPrompt, saveDefaults]);

  useEffect(() => {
    if (draftKey === undefined) return;
    const uploaded = images.items.flatMap((i) => (i.path === null ? [] : [{ n: i.n, token: i.token, path: i.path }]));
    setDraftError(writeDraft(draftKey, { prompt: promptEdited ? prompt : '', images: uploaded }));
  }, [draftKey, prompt, promptEdited, images.items]);

  useEffect(() => {
    if (!promptEdited && remembersPrompt) setPrompt(defaults.prompt);
  }, [defaults.prompt, remembersPrompt, promptEdited]);

  useEffect(() => {
    if (savingDefaults > 0 || busy) return;
    const list = agents.filter((a) => a.available);
    const next = list.find((a) => a.agent === defaults.agent) ?? list[0];
    if (next === undefined) return;
    const nextModel = next.agent === defaults.agent && next.models.some((m) => m.value === defaults.model) ? defaults.model : null;
    const supported = nextModel === null ? next.efforts : next.models.find((m) => m.value === nextModel)?.efforts ?? [];
    setAgent(next.agent);
    setMode(normalizeMode(defaults.mode));
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
  const { info, models, efforts } = llmChoices(agents, { agent, model, effort });
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

  const launch = async (): Promise<void> => {
    if (launchDisabled || available.length === 0 || busy || images.pending) return;
    setError(null);
    setBusy(true);
    try {
      await saveQueue.current;
      const spec = { agent, mode, model, effort, prompt: images.expand(prompt) };
      await onLaunch(spec);
      const draftFailure = draftKey === undefined ? null : writeDraft(draftKey, { prompt: '', images: [] });
      // Modale refermée par son lancement : rien à réinitialiser.
      if (!mounted.current) return;
      setDraftError(draftFailure);
      setPrompt('');
      // Garder la main sur le champ : les défauts mémorisés contiennent encore le dernier
      // prompt saisi. L'effacer aussi évite de le restaurer au prochain montage.
      setPromptEdited(true);
      if (remembersPrompt) saveDefaults({ prompt: '' });
      images.reset();
    } catch (err) {
      if (mounted.current) setError(errorMessage(err, 'Lancement impossible'));
    } finally {
      if (mounted.current) setBusy(false);
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
      {heading || project?.workspaceMode === 'shared' ? (
        <div className="new-session-heading">
          {heading ? <h2>{heading}</h2> : null}
          {project?.workspaceMode === 'shared' ? <p className="hint">Travail dans le dossier du projet, sur sa branche courante.</p> : null}
        </div>
      ) : null}
      <LlmSelector
        agents={agents}
        value={{ agent, model, effort }}
        defaults={defaults}
        disabled={busy}
        onChange={selection => {
          setAgent(selection.agent);
          setModel(selection.model);
          setEffort(selection.effort);
          saveDefaults(selection);
        }}
      >
        <div className="tuning">
          <span className="field-label">Mode</span>
          <ChoiceGroup
            compact
            label="Mode"
            value={mode}
            options={MODE_CHOICES.map((m) => ({ value: m, label: MODE_CHIP[m], title: MODE_DESCRIPTION[m], danger: m === 'bypass' }))}
            onChange={(next) => {
              setMode(next);
              saveDefaults({ mode: next });
            }}
          />
        </div>
      </LlmSelector>
      <label className="block">
        Prompt
        <textarea
          rows={initialPrompt === undefined || initialPrompt === '' ? 5 : 10}
          value={prompt}
          {...fieldProps}
          onBlur={() => {
            if (remembersPrompt && promptEdited && !images.pending && expandedPrompt !== queuedPrompt.current) saveDefaults({ prompt: expandedPrompt });
          }}
          onKeyDown={onKeyDown}
          ref={promptRef}
          placeholder={`${SUBMIT_HINT} pour lancer · Ctrl+V ou glisser-déposer pour joindre une image`}
        />
        <AttachmentStrip {...stripProps} />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      {draftError ? <p className="form-error">Brouillon non sauvegardé : {draftError}</p> : null}
      {defaultsError ? <p className="form-error">Réglages non sauvegardés : {defaultsError}</p> : null}
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={launchDisabled || busy || images.pending || available.length === 0}>
          <ActivityStatus active={busy || images.pending}>{busy ? 'Lancement…' : images.pending ? 'Envoi des images…' : launchLabel}</ActivityStatus>
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
