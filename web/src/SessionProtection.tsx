import { useAsyncAction } from './async-action.ts';
import { useStore } from './store.tsx';
import type { Session } from '../../shared/types.ts';

export const SESSION_PROTECTED_HINT = 'Session protégée. Décochez sa protection avant de la supprimer.';

export function SessionProtection({ session, onError }: { session: Session; onError: (message: string) => void }) {
  const { setSessionProtected } = useStore();
  // Seuls les échecs remontent : le lancement n'efface pas l'erreur affichée par le parent.
  const { run: change, busy } = useAsyncAction((value: boolean) => setSessionProtected(session.id, value), {
    fallback: 'Modification de la protection impossible',
    onError: (message) => {
      if (message !== null) onError(message);
    },
  });

  return (
    <label
      className={`session-toggle${session.protected ? ' active' : ''}`}
      title={
        session.protected
          ? 'Session protégée — cliquer pour autoriser sa suppression'
          : 'Protéger la session contre la suppression et la purge'
      }
    >
      <input
        type="checkbox"
        aria-label="Protéger la session contre la suppression"
        checked={session.protected}
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
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d={session.protected ? 'M8 10V6a4 4 0 0 1 8 0v4' : 'M8 10V6a4 4 0 0 1 7.5-2'} />
        <path d="M12 14v3" />
      </svg>
    </label>
  );
}
