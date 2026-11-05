import { useCallback, useEffect, useState } from 'react';
import { ActivityStatus } from '../ActivityStatus.tsx';
import { ApiError, cancelCouncil, getCouncil, markOperationSeen } from '../api.ts';
import { DelayedActionButton } from '../DelayedActionButton.tsx';
import {
  COUNCIL_STATUS_LABEL,
  COUNCIL_STEPS,
  errorMessage,
  formatDuration,
  relativeTime,
  SYNTHESIS_SECTIONS,
} from '../format.ts';
import { Markdown } from '../Markdown.tsx';
import { useNow, usePolling } from '../polling.tsx';
import { useStore } from '../store.tsx';
import { useLatest } from '../use-latest.ts';
import type { CouncilRun } from '../../../shared/types.ts';
import { projectLabel } from './CouncilsTab.tsx';
// Règles `.md` du rendu Markdown ; le reste du fichier est limité aux classes council-* et persona-*.
import '../council.css';

const STATUS_EXPLANATION: Partial<Record<CouncilRun['status'], string>> = {
  failed: 'Le council n’a pas pu aboutir : les avis obtenus sont conservés ci-dessous.',
  cancelled: 'Le council a été annulé : les avis obtenus avant l’annulation sont conservés ci-dessous.',
  interrupted:
    'Le serveur Cerebro s’est arrêté pendant ce council, qui ne reprend pas. Les avis obtenus sont conservés ci-dessous.',
};

function Progress({ run, onCancel, cancelling }: { run: CouncilRun; onCancel: () => void; cancelling: boolean }) {
  const now = useNow();
  const index = COUNCIL_STEPS.findIndex((step) => step.phase === run.phase);
  const step = COUNCIL_STEPS[index];
  const received = run.answers.filter((answer) => answer.finishedAt !== null).length;
  return (
    <section className="m-section" aria-label="Avancement du council">
      <p className="m-council-step">
        <ActivityStatus>
          {step === undefined ? 'Démarrage…' : `Étape ${index + 1}/${COUNCIL_STEPS.length} : ${step.label}`}
        </ActivityStatus>
      </p>
      {step === undefined ? null : <p className="m-hint">{step.detail}</p>}
      <p className="m-hint">
        {received}/{run.advisors.length} avis reçus · lancé {relativeTime(run.startedAt, now)}
      </p>
      <DelayedActionButton
        className="m-button m-danger"
        cancelLabel="Ne pas annuler"
        disabled={cancelling}
        onAction={onCancel}
      >
        {cancelling ? 'Annulation…' : 'Annuler le council'}
      </DelayedActionButton>
    </section>
  );
}

function Synthesis({ run }: { run: CouncilRun }) {
  const synthesis = run.synthesis;
  if (synthesis === null) return null;
  return (
    <section className="m-section" aria-labelledby="m-synthesis-title">
      <h2 className="m-section-title" id="m-synthesis-title">
        Synthèse
      </h2>
      {SYNTHESIS_SECTIONS.map(({ key, label }) => (
        <section key={key} className="m-synthesis-part">
          <h3 className="m-synthesis-label">{label}</h3>
          {synthesis[key].trim() === '' ? (
            <p className="m-hint">Rien à signaler.</p>
          ) : (
            <Markdown text={synthesis[key]} />
          )}
        </section>
      ))}
    </section>
  );
}

function Answers({ run }: { run: CouncilRun }) {
  const finished = run.advisors.flatMap((advisor) => {
    const answer = run.answers.find((entry) => entry.advisorId === advisor.personaId && entry.finishedAt !== null);
    return answer === undefined ? [] : [{ advisor, answer }];
  });
  if (finished.length === 0) return null;
  return (
    <section className="m-section" aria-labelledby="m-answers-title">
      <h2 className="m-section-title" id="m-answers-title">
        Avis des conseillers
      </h2>
      {finished.map(({ advisor, answer }) => (
        <details key={advisor.personaId} className="m-answer">
          <summary>
            <span className="m-answer-name">{advisor.name}</span>
            {answer.error !== null ? <span className="m-council-status failed">échec</span> : null}
          </summary>
          {answer.error !== null ? (
            <p className="m-form-error">{answer.error}</p>
          ) : (
            <Markdown text={answer.text ?? ''} />
          )}
        </details>
      ))}
    </section>
  );
}

/** Écran `#/c/<id>` : question, statut, synthèse et avis repliés ; suivi tant que le run tourne. */
export function CouncilScreen({ councilId }: { councilId: string }) {
  const { projects } = useStore();
  const [run, setRun] = useState<CouncilRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const finished = run !== null && run.finishedAt !== null;

  const fetchRun = useCallback(() => getCouncil(councilId), [councilId]);
  usePolling(fetchRun, 2000, {
    enabled: !missing && !finished,
    onData: (value) => {
      setRun(value);
      setError(null);
    },
    onError: (cause) => {
      if (cause instanceof ApiError && cause.status === 404) setMissing(true);
      else setError(errorMessage(cause));
    },
  });
  // Rapport affiché : le résultat ne doit plus être notifié.
  const finishedId = finished ? run.id : null;
  useEffect(() => {
    if (finishedId !== null) markOperationSeen(`council:${finishedId}`);
  }, [finishedId]);

  // L'annulation part 5 s après le tap (DelayedActionButton) : elle lit le run de ce moment-là, pas celui du tap.
  const latestRun = useLatest(run);
  const cancel = async (): Promise<void> => {
    const current = latestRun.current;
    // Terminé seul pendant le délai : rien à annuler.
    if (current === null || current.finishedAt !== null) return;
    setCancelling(true);
    try {
      setRun(await cancelCouncil(current.id));
      setError(null);
    } catch (cause) {
      setError(`Annulation impossible : ${errorMessage(cause)}`);
    } finally {
      setCancelling(false);
    }
  };

  if (missing) {
    return (
      <section className="m-content">
        <p className="m-hint">Ce council n’existe pas ou a été supprimé.</p>
      </section>
    );
  }
  if (run === null) {
    return (
      <section className="m-content">
        {error === null ? (
          <p className="m-hint">Chargement…</p>
        ) : (
          <p className="m-form-error" role="alert">
            Chargement impossible : {error}
          </p>
        )}
      </section>
    );
  }

  const explanation = STATUS_EXPLANATION[run.status];
  return (
    <div className="m-content m-council">
      <p className="m-card-meta m-council-meta">
        <span className={`m-council-status ${run.status}`}>{COUNCIL_STATUS_LABEL[run.status]}</span>
        <span>{projectLabel(run.projectId, projects)}</span>
        <span>{new Date(run.startedAt).toLocaleString()}</span>
        {run.finishedAt === null ? null : <span>{formatDuration(run.finishedAt - run.startedAt, 'seconds')}</span>}
      </p>
      <section className="m-section" aria-labelledby="m-question-title">
        <h2 className="m-section-title" id="m-question-title">
          Question
        </h2>
        <p className="m-council-question">{run.question}</p>
      </section>
      {error === null ? null : (
        <p className="m-form-error" role="alert">
          {error}
        </p>
      )}
      {finished ? null : <Progress run={run} cancelling={cancelling} onCancel={() => void cancel()} />}
      {explanation === undefined ? null : (
        <div className={`m-council-notice ${run.status}`} role="status">
          <p>{explanation}</p>
          {run.error === null ? null : <p className="m-council-error">{run.error}</p>}
        </div>
      )}
      <Synthesis run={run} />
      <Answers run={run} />
    </div>
  );
}
