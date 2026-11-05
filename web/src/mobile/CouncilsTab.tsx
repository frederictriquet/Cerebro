import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, getCouncil, listCouncils, startCouncil } from '../api.ts';
import { COUNCIL_STATUS_LABEL, errorMessage, relativeTime, truncate } from '../format.ts';
import { useNow, usePolling } from '../polling.tsx';
import { go, href } from '../route.ts';
import { useStore } from '../store.tsx';
import type { CouncilRun, Project } from '../../../shared/types.ts';

// Lancement en attente de réponse : relancé avec le même identifiant tant que question et projet sont inchangés.
interface PendingLaunch {
  requestId: string;
  key: string;
}

export function projectLabel(projectId: string | null, projects: readonly Project[]): string {
  if (projectId === null) return 'Hors projet';
  return projects.find((project) => project.id === projectId)?.name ?? 'Projet supprimé';
}

/**
 * Convocation d'un council avec la question et le projet seuls : le serveur applique les réglages du council du
 * projet, sinon les réglages globaux (participants, lecture du dépôt), sans accès web.
 */
function CouncilForm() {
  const { projects } = useStore();
  const [question, setQuestion] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLaunch | null>(null);
  // Un projet supprimé entre-temps n'est plus proposé : le lancement repart hors projet.
  const scope = projectId !== null && projects.some((project) => project.id === projectId) ? projectId : null;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = question.trim();
    if (busy || trimmed === '') return;
    setBusy(true);
    setError(null);
    const input = { projectId: scope, question: trimmed };
    const key = JSON.stringify(input);
    // Toute modification de la question ou du projet ouvre une nouvelle soumission, avec un nouvel identifiant.
    const attempt = pending?.key === key ? pending : { requestId: crypto.randomUUID(), key };
    setPending(attempt);
    try {
      const run = await startCouncil({ requestId: attempt.requestId, ...input });
      go(`#/c/${encodeURIComponent(run.id)}`);
    } catch (cause) {
      // Sans réponse du serveur, le council a pu être créé : on le retrouve par son identifiant.
      if (!(cause instanceof ApiError)) {
        try {
          const run = await getCouncil(attempt.requestId);
          go(`#/c/${encodeURIComponent(run.id)}`);
          return;
        } catch {
          // Introuvable ou serveur toujours injoignable : l'erreur d'origine est affichée, la relance réutilisera l'identifiant.
        }
      }
      setError(errorMessage(cause, 'Lancement impossible'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="m-section" aria-labelledby="m-council-launch-title">
      <h2 className="m-section-title" id="m-council-launch-title">
        Nouveau council
      </h2>
      <form className="m-form" onSubmit={(event) => void submit(event)}>
        <textarea
          className="m-textarea"
          rows={4}
          value={question}
          placeholder="Question posée au council"
          aria-label="Question"
          onChange={(event) => setQuestion(event.target.value)}
        />
        <label className="m-field">
          <span>Projet</span>
          <select
            className="m-select"
            value={scope ?? ''}
            disabled={busy}
            onChange={(event) => setProjectId(event.target.value === '' ? null : event.target.value)}
          >
            <option value="">Hors projet</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <p className="m-hint">Participants et options : réglages du council du projet, sinon réglages globaux.</p>
        <button type="submit" className="m-button primary" disabled={busy || question.trim() === ''}>
          {busy ? 'Lancement…' : 'Réunir le council'}
        </button>
        {error === null ? null : (
          <p className="m-form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

function CouncilCard({ run, projects, now }: { run: CouncilRun; projects: readonly Project[]; now: number }) {
  return (
    <a className="m-card" href={href(`#/c/${encodeURIComponent(run.id)}`)}>
      <span className="m-card-title">{truncate(run.question, 140)}</span>
      <span className="m-card-meta">
        <span className={`m-council-status ${run.status}`}>{COUNCIL_STATUS_LABEL[run.status]}</span>
        <span>{projectLabel(run.projectId, projects)}</span>
        <span>{relativeTime(run.startedAt, now)}</span>
      </span>
    </a>
  );
}

/** Onglet « Councils » : lancement, puis runs du plus récent au plus ancien (ordre du serveur). */
export function CouncilsTab() {
  const { projects } = useStore();
  const now = useNow();
  const [runs, setRuns] = useState<CouncilRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Suit l'avancement des councils en cours, sans événement temps réel.
  const running = runs?.some((run) => run.status === 'running') ?? false;
  const fetchRuns = useCallback(() => listCouncils(), []);
  const load = usePolling(fetchRuns, 5000, {
    enabled: running,
    immediate: false,
    onData: (list) => {
      setRuns(list);
      setError(null);
    },
    onError: (cause) => setError(errorMessage(cause)),
  });
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <CouncilForm />
      <section className="m-section" aria-labelledby="m-council-list-title">
        <h2 className="m-section-title" id="m-council-list-title">
          Councils récents
        </h2>
        {error === null ? null : (
          <p className="m-form-error" role="alert">
            Liste indisponible : {error}
          </p>
        )}
        {runs === null ? (
          error === null ? (
            <p className="m-hint">Chargement…</p>
          ) : null
        ) : runs.length === 0 ? (
          <p className="m-hint">Aucun council.</p>
        ) : (
          <ul className="m-list">
            {runs.map((run) => (
              <li key={run.id}>
                <CouncilCard run={run} projects={projects} now={now} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
