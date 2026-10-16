import type { DisplayStatus } from './format.ts';

export function StatusDot({ status, title }: { status: DisplayStatus; title?: string }) {
  // Une question en attente porte un « ? » : la couleur seule ne suffit pas à la distinguer.
  if (status === 'waiting') {
    return (
      <span className="dot waiting ask-mark" title={title ?? status}>
        ?
      </span>
    );
  }
  return <span className={`dot ${status}`} title={title ?? status} />;
}
