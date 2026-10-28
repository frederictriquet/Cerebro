import { useState } from 'react';
import { ActivityStatus } from './ActivityStatus.tsx';
import { getSessionTranscript, type SessionTranscript } from './api.ts';
import { useAsyncAction } from './async-action.ts';
import { CouncilLaunch } from './CouncilLaunch.tsx';
import { Modal } from './Dialog.tsx';
import type { Session } from '../../shared/types.ts';

// « Council » : la conversation de la session (y compris issue d'un council) devient le contexte d'un nouveau
// council du projet ; question et participants restent à choisir. La conversation est relue à chaque ouverture.
export function SessionCouncilButton({ session, onError }: { session: Session; onError: (message: string) => void }) {
  const [transcript, setTranscript] = useState<SessionTranscript | null>(null);
  const { run: open, busy } = useAsyncAction(async () => setTranscript(await getSessionTranscript(session.id)), {
    fallback: 'Conversation illisible',
    onError: (message) => {
      if (message !== null) onError(message);
    },
  });
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={busy}
        title="Soumettre cette conversation à un council : elle devient le contexte de la question posée aux conseillers"
        onClick={() => void open()}
      >
        <ActivityStatus active={busy}>Council</ActivityStatus>
      </button>
      {transcript !== null ? (
        <Modal title="Soumettre la session à un council" onClose={() => setTranscript(null)}>
          <p className="hint">
            {transcript.complete
              ? 'Le contexte reprend la conversation : demandes de l’utilisateur et réponses de l’agent, sans les appels d’outils.'
              : 'Transcript introuvable : le contexte ne reprend que la demande initiale de la session.'}
            {transcript.truncated
              ? ' Trop longue, elle est abrégée : la demande initiale et les derniers échanges sont gardés.'
              : ''}
          </p>
          <CouncilLaunch
            projectId={session.projectId}
            draftKey={`session-${session.id}`}
            initialContext={transcript.text}
            embedded
          />
        </Modal>
      ) : null}
    </>
  );
}
