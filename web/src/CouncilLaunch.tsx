import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react';
import { ActivityStatus } from './ActivityStatus.tsx';
import { ApiError, clipboardImage, deleteCouncil, getCouncil, getEffectiveCouncilSettings, listCouncils, listPersonas, startCouncil, uploadCouncilImage, type CouncilStartInput } from './api.ts';
import { AttachmentStrip, insertToken, removeToken, restoredAttachment, useImageAttachments } from './attachments.tsx';
import { CouncilAdvisorList } from './CouncilAdvisorList.tsx';
import { assignmentOf, CouncilSettingsDialog } from './CouncilSettingsDialog.tsx';
import { DelayedActionButton } from './DelayedActionButton.tsx';
import type { DraftImage } from './drafts.ts';
import { relativeTime } from './format.ts';
import { PersonasDialog } from './PersonasDialog.tsx';
import { go, href, useNow } from './route.ts';
import {
  MAX_ADVISORS,
  MIN_ADVISORS,
  type CouncilRun,
  type CouncilSettings,
  type CouncilStatus,
  type Llm,
  type Persona,
} from '../../shared/types.ts';
import './council.css';

// Brouillon d'un council non lancé, par périmètre (projet ou accueil), comme les brouillons de prompt.
// Les images déjà envoyées au serveur sont conservées avec leur jeton « [Image #n] ».
interface CouncilDraft {
  question: string;
  context: string;
  // null : participants par défaut des réglages effectifs.
  personaIds: string[] | null;
  images: DraftImage[];
}

const DRAFT_PREFIX = 'cerebro.council-draft.';
const EMPTY_DRAFT: CouncilDraft = { question: '', context: '', personaIds: null, images: [] };

function isDraftImage(value: unknown): value is DraftImage {
  return typeof value === 'object' && value !== null
    && typeof (value as DraftImage).n === 'number' && typeof (value as DraftImage).token === 'string' && typeof (value as DraftImage).path === 'string';
}

function readCouncilDraft(key: string): CouncilDraft {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + key);
    if (raw === null) return EMPTY_DRAFT;
    const draft = JSON.parse(raw) as Partial<CouncilDraft>;
    return {
      question: typeof draft.question === 'string' ? draft.question : '',
      context: typeof draft.context === 'string' ? draft.context : '',
      personaIds: Array.isArray(draft.personaIds) ? draft.personaIds.filter((id): id is string => typeof id === 'string') : null,
      images: Array.isArray(draft.images) ? draft.images.filter(isDraftImage) : [],
    };
  } catch (err) {
    console.warn('Brouillon de council illisible', key, err);
    return EMPTY_DRAFT;
  }
}

function writeCouncilDraft(key: string, draft: CouncilDraft): void {
  try {
    if (draft.question.trim() === '' && draft.context.trim() === '' && draft.personaIds === null && draft.images.length === 0) localStorage.removeItem(DRAFT_PREFIX + key);
    else localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify(draft));
  } catch (err) {
    console.warn('Brouillon de council non enregistré', key, err);
  }
}

// Les images sont attachées au message de chaque appel : conseillers et chairman doivent les accepter.
const IMAGE_AGENTS: readonly string[] = ['claude', 'codex'];

const STATUS_LABELS: Record<CouncilStatus, string> = {
  running: 'en cours',
  succeeded: 'terminé',
  failed: 'échec',
  cancelled: 'annulé',
  interrupted: 'interrompu',
};

const QUESTION_PREVIEW = 120;

// Lancement envoyé dont l'issue reste à confirmer : une nouvelle tentative des mêmes paramètres
// réutilise son identifiant, pour que le serveur rende le council déjà créé au lieu d'en créer un second.
interface PendingLaunch {
  requestId: string;
  // Paramètres sérialisés de la soumission, hors identifiant.
  key: string;
}

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function PastCouncils({ runs, error, now, onDelete }: {
  runs: CouncilRun[] | null;
  error: string | null;
  now: number;
  onDelete: (id: string) => void;
}) {
  if (error) return <p className="form-error" role="alert">Historique indisponible : {error}</p>;
  if (runs === null) return <ActivityStatus>Chargement…</ActivityStatus>;
  if (runs.length === 0) return <p className="empty-hint">Aucun council pour l’instant.</p>;
  return <ul className="council-runs">
    {runs.map(run => <li key={run.id} className="council-run">
      <a className="council-run-link" href={href(`#/c/${run.id}`)} title={run.question}>
        <span className="council-run-meta">
          <span className={`council-run-status ${run.status}`}>{STATUS_LABELS[run.status]}</span>
          <span title={new Date(run.startedAt).toLocaleString()}>{relativeTime(run.startedAt, now)}</span>
        </span>
        <span className="council-run-question">{truncate(run.question, QUESTION_PREVIEW)}</span>
        <span className="council-run-advisors">{run.advisors.map(advisor => advisor.name).join(' · ')}</span>
      </a>
      {run.status === 'running' ? null : <DelayedActionButton onAction={() => onDelete(run.id)} title="Supprime ce council et son rapport">Supprimer</DelayedActionButton>}
    </li>)}
  </ul>;
}

// Convocation d'un council : question, contexte, participants et réglages propres à ce lancement.
// Remonté à chaque changement de périmètre : brouillon et réglages ne passent pas d'un projet à l'autre.
export function CouncilLaunch({ projectId }: { projectId?: string }) {
  return <CouncilLaunchForm key={projectId ?? 'home'} projectId={projectId}/>;
}

function CouncilLaunchForm({ projectId }: { projectId?: string }) {
  const scope = projectId ?? null;
  const draftKey = projectId ?? 'home';
  const now = useNow();
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [settings, setSettings] = useState<CouncilSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CouncilDraft>(() => readCouncilDraft(draftKey));
  // Agent, modèle et effort choisis pour ce lancement seulement.
  const [overrides, setOverrides] = useState<Record<string, Llm>>({});
  const [readProject, setReadProject] = useState<boolean | null>(null);
  const [runs, setRuns] = useState<CouncilRun[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLaunch | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [personasOpen, setPersonasOpen] = useState(false);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const contextRef = useRef<HTMLTextAreaElement>(null);
  // Une seule numérotation pour la question et le contexte.
  const images = useImageAttachments(
    (image) => uploadCouncilImage(scope, image),
    draft.images.map((image) => restoredAttachment(image.n, image.token, image.path)),
  );

  const loadPersonas = async (): Promise<void> => {
    try {
      const loaded = await listPersonas();
      setPersonas(loaded);
      // Un changement des défauts ne doit pas effacer les choix de ce lancement.
      // Seules les personas retirées du catalogue perdent leur surcharge.
      const known = new Set(loaded.map(persona => persona.id));
      setOverrides(current => Object.fromEntries(Object.entries(current).filter(([id]) => known.has(id))));
      setLoadError(null);
    } catch (cause) {
      setLoadError(message(cause));
    }
  };
  const loadSettings = async (): Promise<void> => {
    try {
      const loaded = await getEffectiveCouncilSettings(scope);
      setSettings(loaded);
      setReadProject(current => current ?? loaded.readProject);
      setLoadError(null);
    } catch (cause) {
      setLoadError(message(cause));
    }
  };
  // Supprimer une persona répare aussi les participants par défaut côté serveur : un brouillon
  // qui suit ces défauts doit adopter le remplaçant choisi plutôt que perdre un participant.
  const refreshCatalog = (): void => {
    void loadPersonas();
    void loadSettings();
  };
  const loadRuns = async (): Promise<void> => {
    try {
      setRuns(await listCouncils(scope));
      setRunsError(null);
    } catch (cause) {
      setRunsError(message(cause));
    }
  };

  useEffect(() => {
    void loadPersonas();
    void loadSettings();
    void loadRuns();
  }, []);
  const uploadedImages = images.items.flatMap((item) => (item.path === null ? [] : [{ n: item.n, token: item.token, path: item.path }]));
  useEffect(() => writeCouncilDraft(draftKey, { ...draft, images: uploadedImages }), [draft, images.items]);
  // Suit l'avancement des councils en cours, sans événement temps réel.
  const running = runs?.some(run => run.status === 'running') ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void loadRuns(), 5000);
    return () => window.clearInterval(timer);
  }, [running]);

  const known = new Set(personas?.map(persona => persona.id) ?? []);
  const checkedIds = (draft.personaIds ?? settings?.defaultPersonaIds ?? []).filter(id => known.has(id));
  const llmOf = (personaId: string): Llm | null => {
    if (settings === null) return null;
    return overrides[personaId] ?? assignmentOf(settings, personaId);
  };
  const count = checkedIds.length;
  const countError = count < MIN_ADVISORS
    ? `Cochez au moins ${MIN_ADVISORS} conseillers.`
    : count > MAX_ADVISORS ? `Un council compte au plus ${MAX_ADVISORS} conseillers.` : null;
  const ready = personas !== null && settings !== null;
  // Avec des images, chaque agent sollicité doit savoir les recevoir.
  const unableNames = images.items.length === 0 || !ready ? [] : [
    ...personas.filter(persona => checkedIds.includes(persona.id) && !IMAGE_AGENTS.includes(llmOf(persona.id)!.agent)).map(persona => `${persona.name} (${llmOf(persona.id)!.agent})`),
    ...IMAGE_AGENTS.includes(settings.chairman.agent) ? [] : [`chairman (${settings.chairman.agent})`],
  ];
  const imageError = unableNames.length === 0 ? null : `Images jointes : ${unableNames.join(', ')} ne ${unableNames.length > 1 ? 'prennent' : 'prend'} pas en charge les images. Choisissez claude ou codex.`;
  const canLaunch = ready && !busy && !images.pending && countError === null && imageError === null && draft.question.trim() !== '';

  const toggle = (personaId: string, checked: boolean): void => {
    const others = checkedIds.filter(id => id !== personaId);
    setDraft({ ...draft, personaIds: checked ? [...others, personaId] : others });
  };

  // Image collée ou déposée dans un champ : « [Image #N] » est inséré au curseur ; le serveur attache
  // les fichiers au message de chaque appel, les jetons restent dans le texte pour les désigner.
  const attachImage = (field: 'question' | 'context', image: File): void => {
    const el = (field === 'question' ? questionRef : contextRef).current;
    const text = draft[field];
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const token = images.add(image, (failed, message) => {
      setDraft(current => ({ ...current, question: removeToken(current.question, failed), context: removeToken(current.context, failed) }));
      setError(`Image non envoyée : ${message}`);
    });
    setDraft(current => ({ ...current, [field]: insertToken(current[field], start, end, token) }));
  };
  const onPaste = (field: 'question' | 'context') => (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const image = clipboardImage(event.clipboardData);
    if (image === null) return;
    event.preventDefault();
    attachImage(field, image);
  };
  const onDrop = (field: 'question' | 'context') => (event: DragEvent<HTMLTextAreaElement>): void => {
    const image = clipboardImage(event.dataTransfer);
    if (image === null) return;
    event.preventDefault();
    attachImage(field, image);
  };
  const edit = (field: 'question' | 'context', value: string): void => {
    const next = { ...draft, [field]: value };
    images.prune(`${next.question}\n${next.context}`);
    setDraft(next);
  };
  const removeImage = (n: number, token: string): void => {
    images.remove(n);
    setDraft(current => ({ ...current, question: removeToken(current.question, token), context: removeToken(current.context, token) }));
  };

  const launch = async (): Promise<void> => {
    if (!canLaunch || personas === null) return;
    setBusy(true);
    setError(null);
    let attempt: PendingLaunch | null = null;
    const opened = (id: string): void => {
      setPending(null);
      setDraft(EMPTY_DRAFT);
      images.reset();
      // Navigation may unmount the form before the draft effect runs: clear the stored draft now.
      writeCouncilDraft(draftKey, EMPTY_DRAFT);
      go(`#/c/${id}`);
    };
    try {
      // Ordre du catalogue, indépendant de l'ordre des clics.
      const participants = personas.filter(persona => checkedIds.includes(persona.id))
        .map(persona => ({ personaId: persona.id, ...llmOf(persona.id)! }));
      const input: Omit<CouncilStartInput, 'requestId'> = {
        projectId: scope,
        question: draft.question.trim(),
        context: draft.context.trim() || undefined,
        readProject: scope !== null && readProject === true,
        participants,
        ...uploadedImages.length === 0 ? {} : { images: uploadedImages.map(image => ({ n: image.n, path: image.path })) },
      };
      const key = JSON.stringify(input);
      // Toute modification des paramètres ouvre une nouvelle soumission, avec un nouvel identifiant.
      attempt = pending?.key === key ? pending : { requestId: crypto.randomUUID(), key };
      setPending(attempt);
      const run = await startCouncil({ requestId: attempt.requestId, ...input });
      opened(run.id);
    } catch (cause) {
      // Sans réponse du serveur, le council a pu être créé : on le retrouve par son identifiant.
      if (attempt !== null && !(cause instanceof ApiError)) {
        try {
          opened((await getCouncil(attempt.requestId)).id);
          return;
        } catch {
          // Introuvable ou serveur toujours injoignable : la relance réutilisera l'identifiant.
        }
      }
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await deleteCouncil(id);
      setRuns(current => current?.filter(run => run.id !== id) ?? current);
    } catch (cause) {
      setRunsError(message(cause));
    }
  };

  return <div className="council-launch">
    <form className="council-launch-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void launch(); }}>
      <label className="council-field">
        <span>Question</span>
        <textarea required rows={3} value={draft.question} disabled={busy} ref={questionRef} placeholder="La décision ou la question à soumettre au council · Ctrl+V ou glisser-déposer pour joindre une image"
          onChange={event => edit('question', event.target.value)} onPaste={onPaste('question')} onDrop={onDrop('question')}/>
      </label>
      <label className="council-field">
        <span>Contexte <span className="hint">(facultatif)</span></span>
        <textarea rows={4} value={draft.context} disabled={busy} ref={contextRef} placeholder="Contraintes, options envisagées, éléments utiles aux conseillers · Ctrl+V ou glisser-déposer pour joindre une image"
          onChange={event => edit('context', event.target.value)} onPaste={onPaste('context')} onDrop={onDrop('context')}/>
      </label>
      <AttachmentStrip items={images.items} onRemove={item => removeImage(item.n, item.token)}/>
      {imageError ? <p className="form-error" role="alert">{imageError}</p> : null}
      {scope !== null ? <label className="council-read-project">
        <input type="checkbox" checked={readProject === true} disabled={busy || readProject === null} onChange={event => setReadProject(event.target.checked)}/>
        <span>Laisser les conseillers lire le projet<span className="hint"> : accès en lecture seule au dépôt.</span></span>
      </label> : <p className="hint">Hors projet : les conseillers répondent sans outils ni accès aux fichiers.</p>}

      <section className="council-settings-section">
        <div className="council-settings-head">
          <h3>Participants</h3>
          <span className="row-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => setPersonasOpen(true)}>Nouvelle persona</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setSettingsOpen(true)} title={scope === null ? 'Réglages globaux du council' : 'Réglages du council pour ce projet'}>Réglages</button>
          </span>
        </div>
        {loadError ? <p className="form-error" role="alert">Chargement impossible : {loadError}</p> : null}
        {!ready && loadError === null ? <ActivityStatus>Chargement…</ActivityStatus> : null}
        {ready ? <CouncilAdvisorList personas={personas} checkedIds={checkedIds} llmOf={id => llmOf(id)!} defaultsOf={id => assignmentOf(settings, id)} disabled={busy} onToggle={toggle} onAssign={(id, llm) => setOverrides({ ...overrides, [id]: llm })}/> : null}
      </section>

      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="council-launch-foot">
        {ready ? <span className={countError ? 'form-error' : 'hint'} role={countError ? 'alert' : undefined}>
          {countError ?? `${count} conseillers · ${2 * count + 1} appels LLM`}
        </span> : null}
        <button type="submit" className="btn primary" disabled={!canLaunch}>
          <ActivityStatus active={busy || images.pending}>{busy ? 'Convocation…' : images.pending ? 'Envoi des images…' : 'Convoquer'}</ActivityStatus>
        </button>
      </div>
    </form>
    <section className="council-settings-section">
      <h3>Councils précédents</h3>
      <PastCouncils runs={runs} error={runsError} now={now} onDelete={id => void remove(id)}/>
    </section>
    {/* Hors du formulaire : ces dialogues contiennent leurs propres formulaires. */}
    {personasOpen ? <PersonasDialog onChange={refreshCatalog} onClose={() => { setPersonasOpen(false); refreshCatalog(); }}/> : null}
    {settingsOpen ? <CouncilSettingsDialog scope={scope === null ? 'global' : { projectId: scope }} onChange={() => void loadSettings()} onClose={() => { setSettingsOpen(false); void loadPersonas(); }}/> : null}
  </div>;
}
