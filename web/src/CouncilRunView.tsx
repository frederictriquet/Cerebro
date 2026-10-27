import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ActivityStatus } from './ActivityStatus.tsx';
import { api, ApiError, apiBase, cancelCouncil, councilExportUrl, councilImageUrl, getCouncil } from './api.ts';
import { readDraft, writeDraft, type DraftImage } from './drafts.ts';
import { Markdown } from './Markdown.tsx';
import { go, href } from './route.ts';
import { useStore } from './store.tsx';
import { usePolling } from './usePolling.ts';
import type {
  Advisor,
  AggregatedRank,
  CouncilAnswer,
  CouncilPhase,
  CouncilReview,
  CouncilRun,
  CouncilStatus,
  CouncilSynthesis,
  Llm,
} from '../../shared/types.ts';
import './council.css';

const STATUS_LABELS: Record<CouncilStatus, string> = {
  running: 'En cours',
  succeeded: 'Terminé',
  failed: 'Échec',
  cancelled: 'Annulé',
  interrupted: 'Interrompu',
};

const STEPS: { phase: Exclude<CouncilPhase, 'finished'>; label: string; detail: string }[] = [
  { phase: 'answering', label: 'Réponses', detail: 'Chaque conseiller répond indépendamment à la question.' },
  { phase: 'reviewing', label: 'Relecture', detail: 'Chaque conseiller classe anonymement les réponses des autres et signale un angle mort.' },
  { phase: 'synthesizing', label: 'Synthèse', detail: 'Le chairman rédige la synthèse à partir des réponses et des relectures.' },
];

const SYNTHESIS_SECTIONS: { key: keyof CouncilSynthesis; label: string }[] = [
  { key: 'agreements', label: 'Accords' },
  { key: 'disagreements', label: 'Désaccords' },
  { key: 'blindSpots', label: 'Angles morts' },
  { key: 'recommendation', label: 'Recommandation' },
  { key: 'firstAction', label: 'Première action' },
];

type StepState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';

const STEP_STATE_LABELS: Record<StepState, string> = {
  waiting: 'en attente',
  running: 'en cours',
  done: 'terminé',
  failed: 'échec',
  skipped: '—',
};

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

function llmLabel(llm: Llm): string {
  return [llm.agent, llm.model ?? 'modèle par défaut', ...llm.effort === null ? [] : [`effort ${llm.effort}`]].join(' · ');
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds} s` : `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
}

// Une étape sans fin enregistrée d'un run terminé a été coupée par l'annulation ou l'arrêt.
function entryState(run: CouncilRun, entry: CouncilAnswer | CouncilReview | undefined): StepState {
  if (entry === undefined) return run.finishedAt === null ? 'waiting' : 'skipped';
  if (entry.error !== null) return 'failed';
  if (entry.finishedAt !== null) return 'done';
  return run.finishedAt === null ? 'running' : 'failed';
}

function reviewState(run: CouncilRun, advisor: Advisor): StepState {
  const review = run.reviews.find((entry) => entry.advisorId === advisor.personaId);
  if (review !== undefined) return entryState(run, review);
  const answer = run.answers.find((entry) => entry.advisorId === advisor.personaId);
  // Sans réponse, le conseiller ne relit pas.
  if (answer !== undefined && answer.finishedAt !== null && answer.text === null) return 'skipped';
  return run.finishedAt === null ? 'waiting' : 'skipped';
}

function synthesisState(run: CouncilRun): StepState {
  if (run.synthesis !== null) return 'done';
  if (run.phase === 'synthesizing') return 'running';
  if (run.finishedAt === null) return 'waiting';
  // Relectures toutes terminées sans synthèse : c'est la synthèse qui a échoué ou été coupée.
  return run.reviews.length > 0 && run.reviews.every((review) => review.finishedAt !== null) ? 'failed' : 'skipped';
}

function StateBadge({ state, error }: { state: StepState; error?: string | null }) {
  return <span className={`council-state ${state}`} title={error ?? undefined}>
    {state === 'running' ? <ActivityStatus>{STEP_STATE_LABELS[state]}</ActivityStatus> : STEP_STATE_LABELS[state]}
  </span>;
}

// Même calcul que `aggregateRanks` côté serveur (server/council.ts), repris pour l'affichage.
function aggregateRanks(run: CouncilRun): AggregatedRank[] {
  const reviews = run.reviews.filter((review) => review.error === null && review.finishedAt !== null);
  return run.answers
    .flatMap((answer) => {
      const letter = run.letters[answer.advisorId];
      return answer.text === null || letter === undefined ? [] : [{ letter, advisorId: answer.advisorId }];
    })
    .map(({ letter, advisorId }) => {
      const ranks = reviews.flatMap((review) => {
        const index = review.ranking.findIndex((rank) => rank.letter === letter);
        return index === -1 ? [] : [index + 1];
      });
      const averageRank = ranks.length === 0 ? null : ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length;
      return { letter, advisorId, averageRank, votes: ranks.length };
    })
    .sort((a, b) => (a.averageRank ?? Infinity) - (b.averageRank ?? Infinity) || a.letter.localeCompare(b.letter));
}

function formatRank(rank: number | null): string {
  return rank === null ? '—' : String(Math.round(rank * 100) / 100).replace('.', ',');
}

function reportUrl(run: CouncilRun): string {
  return `${window.location.origin}${window.location.pathname}${href(`#/c/${run.id}`)}`;
}

function quoted(question: string, max = 160): string {
  const line = question.replace(/\s+/g, ' ').trim();
  return `« ${line.length > max ? `${line.slice(0, max - 1)}…` : line} »`;
}

function backlogText(run: CouncilRun, synthesis: CouncilSynthesis): string {
  return [
    `Recommandation du council ${quoted(run.question)} :`,
    synthesis.recommendation.trim(),
    '',
    'Première action :',
    synthesis.firstAction.trim(),
    '',
    `Rapport : ${reportUrl(run)}`,
  ].join('\n');
}

function sessionPrompt(run: CouncilRun, synthesis: CouncilSynthesis): string {
  return [
    `Un council de conseillers LLM a examiné la question suivante ; poursuis à partir de sa synthèse (rapport complet : ${reportUrl(run)}).`,
    '',
    '## Question',
    run.question.trim(),
    ...run.context.trim() === '' ? [] : ['', '## Contexte', run.context.trim()],
    ...SYNTHESIS_SECTIONS.flatMap((section) => ['', `## ${section.label}`, synthesis[section.key].trim() || '—']),
    '',
    'Commence par la première action ; signale-moi ce qui contredit la synthèse.',
  ].join('\n');
}

// Projet cible des suites : celui du council, sinon un projet à choisir.
// Les images du council rejoignent le brouillon de session sous de nouveaux numéros, après celles
// qu'il contient déjà ; les jetons du prompt sont renumérotés en conséquence.
function withCouncilImages(prompt: string, previous: DraftImage[], run: CouncilRun): { prompt: string; images: DraftImage[] } {
  let next = previous.reduce((max, image) => Math.max(max, image.n), 0);
  const images = [...previous];
  let text = prompt;
  for (const image of [...run.images].sort((a, b) => a.n - b.n)) {
    next += 1;
    const token = `[Image #${next}]`;
    text = text.split(`[Image #${image.n}]`).join(`\u0000${next}\u0000`);
    images.push({ n: next, token, path: image.path });
  }
  return { prompt: text.replace(/\u0000(\d+)\u0000/g, '[Image #$1]'), images };
}

function ProjectPicker({ run, value, onChange }: { run: CouncilRun; value: string; onChange: (id: string) => void }) {
  const { projects } = useStore();
  const own = run.projectId === null ? undefined : projects.find((project) => project.id === run.projectId);
  if (own !== undefined) return <p className="meta">Projet : {own.name}</p>;
  if (projects.length === 0) return <p className="form-error">Aucun projet : créez-en un depuis l’accueil.</p>;
  return <label className="council-field">
    Projet
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
    </select>
  </label>;
}

function useTargetProject(run: CouncilRun): [string, (id: string) => void] {
  const { projects } = useStore();
  const [picked, setPicked] = useState<string | null>(null);
  const own = run.projectId !== null && projects.some((project) => project.id === run.projectId) ? run.projectId : null;
  const chosen = picked !== null && projects.some((project) => project.id === picked) ? picked : projects[0]?.id ?? '';
  return [own ?? chosen, setPicked];
}

function BacklogFollowUp({ run, synthesis, onClose }: { run: CouncilRun; synthesis: CouncilSynthesis; onClose: () => void }) {
  const { projects, createTask } = useStore();
  const [projectId, setProjectId] = useTargetProject(run);
  const [text, setText] = useState(() => backlogText(run, synthesis));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy || projectId === '' || text.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await createTask(projectId, text.trim());
      setCreated(projectId);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  if (created !== null) {
    const project = projects.find((p) => p.id === created);
    return <div className="council-follow-up" role="status">
      <p>Tâche ajoutée au backlog de <a href={href(`#/p/${encodeURIComponent(created)}`)}>{project?.name ?? 'ce projet'}</a>.</p>
      <div className="council-follow-up-foot"><button type="button" className="btn" onClick={onClose}>Fermer</button></div>
    </div>;
  }
  return <form className="council-follow-up" onSubmit={(event) => void submit(event)}>
    <ProjectPicker run={run} value={projectId} onChange={setProjectId}/>
    <label className="council-field">
      Texte de la tâche
      <textarea rows={8} value={text} onChange={(event) => setText(event.target.value)} required/>
    </label>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="council-follow-up-foot">
      <button type="button" className="btn" onClick={onClose}>Annuler</button>
      <button type="submit" className="btn primary" disabled={busy || projectId === '' || text.trim() === ''}>
        {busy ? 'Ajout…' : 'Ajouter au backlog'}
      </button>
    </div>
  </form>;
}

function SessionFollowUp({ run, synthesis, onClose }: { run: CouncilRun; synthesis: CouncilSynthesis; onClose: () => void }) {
  const [projectId, setProjectId] = useTargetProject(run);
  const [error, setError] = useState<string | null>(null);

  const open = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (projectId === '') return;
    const key = `project.${projectId}`;
    // Un brouillon déjà en cours est conservé à la suite de la synthèse, avec ses images.
    const previous = readDraft(key);
    const prompt = [sessionPrompt(run, synthesis), ...previous === null || previous.prompt.trim() === '' ? [] : ['', '---', '', previous.prompt]].join('\n');
    const failure = writeDraft(key, { prompt, images: previous?.images ?? [] });
    if (failure !== null) {
      setError(`Brouillon non enregistré : ${failure}`);
      return;
    }
    go(`#/p/${encodeURIComponent(projectId)}`);
  };

  return <form className="council-follow-up" onSubmit={open}>
    <p className="meta">La synthèse devient le prompt de la prochaine session du projet{run.images.length > 0 ? ', avec les images jointes' : ''} ; vous pourrez le modifier et choisir l’agent avant de lancer.</p>
    <ProjectPicker run={run} value={projectId} onChange={setProjectId}/>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <div className="council-follow-up-foot">
      <button type="button" className="btn" onClick={onClose}>Annuler</button>
      <button type="submit" className="btn primary" disabled={projectId === ''}>Ouvrir le formulaire de session</button>
    </div>
  </form>;
}

function FollowUps({ run }: { run: CouncilRun }) {
  const [open, setOpen] = useState<'backlog' | 'session' | null>(null);
  const synthesis = run.synthesis;
  return <section className="card council-actions" aria-label="Suites du council">
    <h2>Suites</h2>
    <div className="council-actions-row">
      {synthesis !== null ? <>
        <button type="button" className="btn" aria-expanded={open === 'backlog'} onClick={() => setOpen(open === 'backlog' ? null : 'backlog')}>Ajouter au backlog</button>
        <button type="button" className="btn" aria-expanded={open === 'session'} onClick={() => setOpen(open === 'session' ? null : 'session')}>Ouvrir une session</button>
      </> : null}
      <a className="btn" href={councilExportUrl(run.id)} download>Exporter en Markdown</a>
    </div>
    {synthesis !== null && open === 'backlog' ? <BacklogFollowUp run={run} synthesis={synthesis} onClose={() => setOpen(null)}/> : null}
    {synthesis !== null && open === 'session' ? <SessionFollowUp run={run} synthesis={synthesis} onClose={() => setOpen(null)}/> : null}
  </section>;
}

function Progress({ run, now, onCancel, cancelling }: { run: CouncilRun; now: number; onCancel: () => void; cancelling: boolean }) {
  const current = STEPS.findIndex((step) => step.phase === run.phase);
  const leave = (): void => go(run.projectId === null ? '#/' : `#/p/${encodeURIComponent(run.projectId)}`);
  return <section className="card council-progress" aria-label="Avancement du council">
    <h2>Avancement</h2>
    <ol className="council-steps" aria-label="Étapes du council">
      {STEPS.map((step, index) => <li key={step.phase} aria-current={index === current ? 'step' : undefined}
        className={index === current ? 'current' : index < current ? 'done' : undefined}>{step.label}</li>)}
    </ol>
    <p className="council-progress-status">
      <ActivityStatus>{STEPS[current]?.detail ?? 'Démarrage…'}</ActivityStatus>
      <span className="meta">{duration(now - run.startedAt)} écoulées</span>
    </p>
    <AdvisorTable run={run}/>
    <p className="meta">Chairman · {llmLabel(run.settings.chairman)} · synthèse <StateBadge state={synthesisState(run)}/></p>
    <div className="council-actions-row">
      <button type="button" className="btn danger-ghost" onClick={onCancel} disabled={cancelling}>{cancelling ? 'Annulation…' : 'Annuler'}</button>
      <button type="button" className="btn" onClick={leave} title="Le council continue sur le serveur ; son résultat est notifié et reste disponible ici.">Continuer en arrière-plan</button>
    </div>
  </section>;
}

function AdvisorTable({ run }: { run: CouncilRun }) {
  return <div className="council-table">
    <table>
      <thead><tr><th>Lettre</th><th>Conseiller</th><th>Agent</th><th>Réponse</th><th>Relecture</th></tr></thead>
      <tbody>
        {run.advisors.map((advisor) => {
          const answer = run.answers.find((entry) => entry.advisorId === advisor.personaId);
          const review = run.reviews.find((entry) => entry.advisorId === advisor.personaId);
          return <tr key={advisor.personaId}>
            <td>{run.letters[advisor.personaId] ?? '?'}</td>
            <td>{advisor.name}</td>
            <td className="meta">{llmLabel(advisor)}</td>
            <td><StateBadge state={entryState(run, answer)} error={answer?.error}/>{answer?.error ? <span className="council-error">{answer.error}</span> : null}</td>
            <td><StateBadge state={reviewState(run, advisor)} error={review?.error}/>{review?.error ? <span className="council-error">{review.error}</span> : null}</td>
          </tr>;
        })}
      </tbody>
    </table>
  </div>;
}

function Synthesis({ synthesis }: { synthesis: CouncilSynthesis }) {
  return <section className="card council-synthesis" aria-label="Synthèse du chairman">
    <h2>Synthèse</h2>
    {SYNTHESIS_SECTIONS.map(({ key, label }) => <section key={key} className={`council-synthesis-section ${key}`}>
      <h3>{label}</h3>
      {synthesis[key].trim() === '' ? <p className="empty-hint">Rien à signaler.</p> : <Markdown text={synthesis[key]}/>}
    </section>)}
  </section>;
}

function Answers({ run }: { run: CouncilRun }) {
  const finished = run.advisors.filter((advisor) => run.answers.some((answer) => answer.advisorId === advisor.personaId && answer.finishedAt !== null));
  if (finished.length === 0) return null;
  return <section className="card council-answers" aria-label="Avis des conseillers">
    <h2>Avis des conseillers</h2>
    {finished.map((advisor) => {
      const answer = run.answers.find((entry) => entry.advisorId === advisor.personaId)!;
      return <details key={advisor.personaId} className="council-answer">
        <summary>
          <span className="council-letter">{run.letters[advisor.personaId] ?? '?'}</span>
          <span className="council-answer-name">{advisor.name}</span>
          <span className="meta">{llmLabel(advisor)}</span>
          {answer.error !== null ? <span className="council-state failed">échec</span> : null}
        </summary>
        {advisor.description ? <p className="meta">{advisor.description}</p> : null}
        {answer.error !== null ? <p className="form-error">{answer.error}</p> : <Markdown text={answer.text ?? ''}/>}
      </details>;
    })}
  </section>;
}

function Reviews({ run }: { run: CouncilRun }) {
  const reviews = run.reviews.filter((review) => review.finishedAt !== null || review.error !== null);
  if (reviews.length === 0) return null;
  const byId = new Map(run.advisors.map((advisor) => [advisor.personaId, advisor]));
  const byLetter = new Map(Object.entries(run.letters).map(([advisorId, letter]) => [letter, byId.get(advisorId)]));
  const ranks = aggregateRanks(run);
  return <section className="card council-reviews" aria-label="Relectures croisées">
    <h2>Relectures croisées</h2>
    {ranks.some((rank) => rank.votes > 0) ? <div className="council-table">
      <table>
        <caption>Rangs agrégés (1 = meilleure réponse)</caption>
        <thead><tr><th>Position</th><th>Lettre</th><th>Conseiller</th><th>Rang moyen</th><th>Relectures</th></tr></thead>
        <tbody>
          {ranks.map((rank, index) => <tr key={rank.letter}>
            <td>{index + 1}</td>
            <td>{rank.letter}</td>
            <td>{byId.get(rank.advisorId)?.name ?? rank.advisorId}</td>
            <td>{formatRank(rank.averageRank)}</td>
            <td>{rank.votes}</td>
          </tr>)}
        </tbody>
      </table>
    </div> : null}
    {reviews.map((review) => {
      const reviewer = byId.get(review.advisorId);
      return <details key={review.advisorId} className="council-review">
        <summary>
          <span className="council-letter">{run.letters[review.advisorId] ?? '?'}</span>
          <span className="council-answer-name">Relecture de {reviewer?.name ?? review.advisorId}</span>
          {review.error !== null ? <span className="council-state failed">échec</span> : null}
        </summary>
        {review.error !== null ? <p className="form-error">{review.error}</p> : <>
          <h3>Classement</h3>
          <ol className="council-ranking">
            {review.ranking.map((rank) => <li key={rank.letter}>
              <strong>{rank.letter}</strong>{byLetter.get(rank.letter) ? ` (${byLetter.get(rank.letter)!.name})` : ''}
              {rank.reason ? <> — {rank.reason}</> : null}
            </li>)}
          </ol>
          <h3>Angle mort</h3>
          {review.blindSpot ? <Markdown text={review.blindSpot}/> : <p className="empty-hint">Aucun signalé.</p>}
          <h3>Ce que toutes les réponses ont manqué</h3>
          {review.missed ? <Markdown text={review.missed}/> : <p className="empty-hint">Rien de signalé.</p>}
        </>}
      </details>;
    })}
  </section>;
}

function Outcome({ run }: { run: CouncilRun }) {
  if (run.status === 'succeeded') return null;
  const explanation = run.status === 'interrupted'
    ? 'Le serveur Cerebro s’est arrêté ou a redémarré pendant ce council : il ne reprend pas. Les avis et relectures obtenus avant l’arrêt sont conservés ci-dessous ; relancez un council pour obtenir une synthèse.'
    : run.status === 'cancelled'
      ? 'Ce council a été annulé : les avis obtenus avant l’annulation sont conservés ci-dessous.'
      : 'Ce council n’a pas pu aboutir : les avis obtenus sont conservés ci-dessous.';
  return <div className={`council-outcome ${run.status}`} role="alert">
    <p><strong>{STATUS_LABELS[run.status]}.</strong> {explanation}</p>
    {run.error ? <p className="council-error">{run.error}</p> : null}
  </div>;
}

// Suivi et rapport d'un council (#/c/<id>) : avancement par phase, puis synthèse, avis, relectures et suites.
export function CouncilRunView({ councilId }: { councilId: string }) {
  const { projects } = useStore();
  const [machineBase] = useState(apiBase);
  const [run, setRun] = useState<CouncilRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(Date.now);

  // Interrogé chaque seconde jusqu'à la fin du council (ou sa disparition), jamais pour une autre machine que celle d'origine.
  const finished = run !== null && run.finishedAt !== null;
  const fetchRun = useCallback(() => getCouncil(councilId), [councilId]);
  usePolling(fetchRun, missing || finished || apiBase() !== machineBase ? null : 1000, {
    onData: (value) => {
      setRun(value);
      setError(null);
    },
    onError: (cause) => {
      if (cause instanceof ApiError && cause.status === 404) setMissing(true);
      else setError(message(cause));
    },
  });
  useEffect(() => {
    setRun(null);
    setMissing(false);
    setError(null);
  }, [councilId]);
  // Rapport affiché : le résultat ne doit plus être notifié.
  const finishedId = finished ? run.id : null;
  useEffect(() => {
    if (finishedId !== null) void api(`/api/operations/${encodeURIComponent(`council:${finishedId}`)}/seen`, { method: 'POST' }).catch(() => {});
  }, [finishedId]);

  const running = run !== null && run.finishedAt === null;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const cancel = async (): Promise<void> => {
    if (run === null) return;
    setCancelling(true);
    try {
      setRun(await cancelCouncil(run.id));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setCancelling(false);
    }
  };

  if (missing) {
    return <div className="pane padded council-view">
      <header className="pane-head"><h1>Council introuvable</h1></header>
      <p className="empty-hint">Ce council n’existe pas ou a été supprimé. <a href={href('#/')}>Retour à l’accueil</a></p>
    </div>;
  }
  if (run === null) {
    return <div className="pane padded council-view">
      {error ? <p className="form-error" role="alert">Chargement impossible : {error}</p> : <ActivityStatus>Chargement du council…</ActivityStatus>}
    </div>;
  }

  const project = run.projectId === null ? null : projects.find((p) => p.id === run.projectId) ?? null;
  return <div className="pane padded council-view">
    <header className="pane-head">
      <div className="pane-head-main">
        <h1>Council <span className={`council-run-status ${run.status}`}>{STATUS_LABELS[run.status].toLowerCase()}</span></h1>
        <p className="meta council-view-meta">
          {run.projectId === null
            ? 'Hors projet'
            : project !== null ? <>Projet <a href={href(`#/p/${encodeURIComponent(project.id)}`)}>{project.name}</a></> : 'Projet supprimé'}
          {run.projectId !== null ? ` · ${run.readProject ? 'lecture du dépôt' : 'sans lecture du dépôt'}` : ''}
          {run.origin === 'slack' ? ' · lancé depuis Slack' : ''}
          {' · '}{new Date(run.startedAt).toLocaleString()}
          {' · '}{duration((run.finishedAt ?? now) - run.startedAt)}
        </p>
      </div>
    </header>
    <section className="card council-question" aria-label="Question posée">
      <h2>Question</h2>
      <p className="council-question-text">{run.question}</p>
      {run.context.trim() !== '' ? <details>
        <summary>Contexte fourni</summary>
        <Markdown text={run.context}/>
      </details> : null}
      {run.images.length > 0 ? <ul className="council-images" aria-label="Images jointes">
        {[...run.images].sort((a, b) => a.n - b.n).map((image) => <li key={image.n}>
          <a href={councilImageUrl(run.id, image.n)} target="_blank" rel="noreferrer" title={`Ouvrir [Image #${image.n}]`}>
            <img src={councilImageUrl(run.id, image.n)} alt={`[Image #${image.n}]`} loading="lazy"/>
            <span>#{image.n}</span>
          </a>
        </li>)}
      </ul> : null}
    </section>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {running ? <Progress run={run} now={now} cancelling={cancelling} onCancel={() => void cancel()}/> : <>
      <Outcome run={run}/>
      {run.synthesis !== null ? <Synthesis synthesis={run.synthesis}/> : null}
      <FollowUps run={run}/>
      {run.status !== 'succeeded' ? <section className="card" aria-label="État des conseillers">
        <h2>Conseillers</h2>
        <AdvisorTable run={run}/>
        <p className="meta">Chairman · {llmLabel(run.settings.chairman)} · synthèse <StateBadge state={synthesisState(run)}/></p>
      </section> : null}
    </>}
    <Answers run={run}/>
    <Reviews run={run}/>
  </div>;
}
