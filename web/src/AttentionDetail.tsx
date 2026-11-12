import { useState } from 'react';
import { useEpicRun } from './epic-runs.ts';
import { errorMessage } from './format.ts';
import { useStore } from './store.tsx';
import type { AgentQuestion, Session } from '../../shared/types.ts';

/**
 * Ce qui attend l'utilisateur, en clair, pour agir sans ouvrir la session : questions de l'agent avec un
 * bouton par option, outil à autoriser avec sa commande, ou dernier message du tour. `reason` est la raison
 * courte affichée quand aucun détail n'est connu.
 */
export function AttentionDetail({
  session,
  reason,
  withKeys = false,
}: {
  session: Session;
  reason: string | null;
  // Entrée et Échap sous une autorisation : file « À traiter » et mobile, où la ligne ne les porte pas.
  withKeys?: boolean;
}) {
  const detail = session.attentionDetail;
  const tone = session.status === 'waiting' ? 'waiting' : 'idle';
  if (detail?.kind === 'questions' && session.status === 'waiting') {
    return <QuestionsForm session={session} questions={detail.questions} />;
  }
  if (detail?.kind === 'permission') {
    return (
      <div className="attention-detail">
        <p className={`reason-line ${tone}`} title={reason ?? undefined}>
          Autorisation demandée{detail.tool ? ` : ${detail.tool}` : ''}
        </p>
        {detail.summary ? <pre className="attention-command">{detail.summary}</pre> : null}
        {withKeys && session.status === 'waiting' ? <PermissionKeys sessionId={session.id} /> : null}
      </div>
    );
  }
  return (
    <div className="attention-detail">
      {reason ? <p className={`reason-line ${tone}`}>{reason}</p> : null}
      {detail?.kind === 'turn' ? (
        <p className="attention-message" title={detail.message}>
          « {detail.message} »
        </p>
      ) : null}
      {session.epic !== null ? <EpicStepValidation session={session} epicId={session.epic.id} /> : null}
    </div>
  );
}

function QuestionsForm({ session, questions }: { session: Session; questions: AgentQuestion[] }) {
  const { answerSessionQuestions } = useStore();
  const [picks, setPicks] = useState<number[][]>(() => questions.map(() => []));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Une seule question à choix unique : un clic suffit. Sinon on coche, puis « Répondre ».
  const direct = questions.length === 1 && questions[0]?.multiSelect === false;
  const submit = (choices: number[][]): void => {
    setPending(true);
    setError(null);
    void answerSessionQuestions(session.id, choices)
      .catch((cause: unknown) => setError(errorMessage(cause, 'Réponse impossible')))
      .finally(() => setPending(false));
  };
  const pick = (questionIndex: number, optionIndex: number, multiSelect: boolean): void => {
    if (direct) {
      submit([[optionIndex]]);
      return;
    }
    setPicks((current) =>
      current.map((picked, index) => {
        if (index !== questionIndex) return picked;
        if (!multiSelect) return [optionIndex];
        return picked.includes(optionIndex)
          ? picked.filter((value) => value !== optionIndex)
          : [...picked, optionIndex].sort((a, b) => a - b);
      }),
    );
  };
  const complete = picks.every((picked) => picked.length > 0);
  return (
    <div className="attention-detail">
      {questions.map((question, questionIndex) => (
        <fieldset key={questionIndex} className="attention-question" disabled={pending}>
          <legend>
            {question.question}
            {question.multiSelect ? <span className="meta"> · plusieurs choix possibles</span> : null}
          </legend>
          <div className="attention-options">
            {question.options.map((option, optionIndex) => {
              const chosen = picks[questionIndex]?.includes(optionIndex) === true;
              return (
                <button
                  key={optionIndex}
                  type="button"
                  className={`attention-option${chosen ? ' chosen' : ''}`}
                  aria-pressed={direct ? undefined : chosen}
                  title={option.preview ?? undefined}
                  onClick={() => pick(questionIndex, optionIndex, question.multiSelect)}
                >
                  <span className="attention-option-label">
                    <span className="attention-option-key">{optionIndex + 1}</span>
                    {option.label}
                  </span>
                  {option.description ? <span className="meta">{option.description}</span> : null}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}
      {direct ? null : (
        <button type="button" className="btn primary" disabled={pending || !complete} onClick={() => submit(picks)}>
          Répondre
        </button>
      )}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

/** Étape d'epic terminée par cette session et en attente de validation : se valide depuis la liste. */
function EpicStepValidation({ session, epicId }: { session: Session; epicId: string }) {
  const { updateTask } = useStore();
  const { run, refresh } = useEpicRun(epicId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskId = run?.status === 'waiting-validation' && run.sessionId === session.id ? run.currentTaskId : null;
  if (!taskId) return null;
  const validate = (): void => {
    setPending(true);
    setError(null);
    void updateTask(taskId, { status: 'done' })
      .then(() => refresh())
      .catch((cause: unknown) => setError(errorMessage(cause, 'Validation impossible')))
      .finally(() => setPending(false));
  };
  return (
    <>
      <button type="button" className="btn primary attention-validate" disabled={pending} onClick={validate}>
        Valider l’étape et poursuivre
      </button>
      {error ? <p className="form-error">{error}</p> : null}
    </>
  );
}

/** Entrée accepte la proposition sélectionnée du dialogue d'autorisation, Échap le refuse. */
function PermissionKeys({ sessionId }: { sessionId: string }) {
  const { sendSessionInput } = useStore();
  const [error, setError] = useState<string | null>(null);
  const send = (data: string): void => {
    setError(null);
    void sendSessionInput(sessionId, data).catch((cause: unknown) => setError(errorMessage(cause, 'Envoi impossible')));
  };
  return (
    <>
      <span className="row-actions">
        <button type="button" className="btn" onClick={() => send('\r')}>
          Entrée
        </button>
        <button type="button" className="btn" onClick={() => send('\x1b')}>
          Échap
        </button>
      </span>
      {error ? <p className="form-error">{error}</p> : null}
    </>
  );
}
