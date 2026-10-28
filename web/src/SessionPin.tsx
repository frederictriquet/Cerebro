import { useAsyncAction } from './async-action.ts';
import { useStore } from './store.tsx';
import type { Session } from '../../shared/types.ts';

export function SessionPin({ session, onError }: { session: Session; onError: (message: string) => void }) {
  const { setSessionPinned } = useStore();
  // Seuls les échecs remontent : le lancement n'efface pas l'erreur affichée par le parent.
  const { run: change, busy } = useAsyncAction((value: boolean) => setSessionPinned(session.id, value), {
    fallback: 'Modification de l’épingle impossible',
    onError: (message) => {
      if (message !== null) onError(message);
    },
  });

  return (
    <label
      className={`session-toggle${session.pinned ? ' active' : ''}`}
      title={
        session.pinned
          ? 'Session épinglée : ouvrir le projet mène à elle. Cliquer pour la désépingler'
          : 'Épingler la session : ouvrir le projet mènera directement à elle (remplace l’épingle actuelle du projet)'
      }
    >
      <input
        type="checkbox"
        aria-label="Épingler la session dans son projet"
        checked={session.pinned}
        disabled={busy}
        onChange={(event) => void change(event.target.checked)}
      />
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 17v5" />
        <path
          d="M5 17h14v-1.8a2 2 0 0 0-1.1-1.8l-1.8-.9a2 2 0 0 1-1.1-1.8V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.7a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2Z"
          fill={session.pinned ? 'currentColor' : 'none'}
        />
      </svg>
    </label>
  );
}
