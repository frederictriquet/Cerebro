import { useAsyncAction } from './async-action.ts';
import { go } from './route.ts';
import { useStore } from './store.tsx';
import type { Project } from '../../shared/types.ts';

export function ProjectPause({ project, onError }: { project: Project; onError: (message: string) => void }) {
  const { setProjectPaused } = useStore();
  const { run: change, busy } = useAsyncAction((value: boolean) => setProjectPaused(project.id, value), {
    fallback: 'Modification de la mise en pause impossible',
    onError: (message) => {
      if (message !== null) onError(message);
    },
  });

  if (project.paused) {
    return (
      <button
        type="button"
        className="btn project-pause-pill"
        disabled={busy}
        title="Ce projet est en pause : cliquer pour le remettre dans les onglets actifs et relancer le git fetch automatique"
        onClick={() => void change(false)}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.5 2.8 13 8l-8.5 5.2Z" fill="currentColor" />
        </svg>
        En pause · Reprendre
      </button>
    );
  }

  return (
    <button
      type="button"
      className="icon-btn"
      disabled={busy}
      aria-label="Mettre le projet en pause"
      title="Mettre le projet en pause : le retire des onglets actifs, coupe le git fetch automatique et ramène à l’accueil"
      onClick={() => {
        void change(true).then((ok) => {
          if (ok) go('#/');
        });
      }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <rect x="6" y="4" width="4" height="16" rx="1" />
        <rect x="14" y="4" width="4" height="16" rx="1" />
      </svg>
    </button>
  );
}
