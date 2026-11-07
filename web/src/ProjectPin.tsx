import { useAsyncAction } from './async-action.ts';
import { PinIcon } from './PinIcon.tsx';
import { useStore } from './store.tsx';
import type { Project } from '../../shared/types.ts';

export function ProjectPin({ project, onError }: { project: Project; onError: (message: string) => void }) {
  const { setProjectPinned } = useStore();
  // Seuls les échecs remontent : le lancement n'efface pas l'erreur affichée par le parent.
  const { run: change, busy } = useAsyncAction((value: boolean) => setProjectPinned(project.id, value), {
    fallback: 'Modification de l’épingle impossible',
    onError: (message) => {
      if (message !== null) onError(message);
    },
  });

  return (
    <label
      className={`session-toggle${project.pinned ? ' active' : ''}`}
      title={
        project.pinned
          ? 'Projet épinglé : basculer sur sa machine depuis le sélecteur ouvre ce projet. Cliquer pour le désépingler'
          : 'Épingler le projet : basculer sur sa machine depuis le sélecteur l’ouvrira directement (remplace l’épingle actuelle de la machine)'
      }
    >
      <input
        type="checkbox"
        aria-label="Épingler le projet sur sa machine"
        checked={project.pinned}
        disabled={busy}
        onChange={(event) => void change(event.target.checked)}
      />
      <PinIcon filled={project.pinned} />
    </label>
  );
}
