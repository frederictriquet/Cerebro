import { useAsyncAction } from './async-action.ts';
import { PinIcon } from './PinIcon.tsx';
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
      <PinIcon filled={session.pinned} />
    </label>
  );
}
