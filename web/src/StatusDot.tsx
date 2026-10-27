import { STATUS_LABEL, type DisplayStatus } from './format.ts';

export function StatusDot({ status, title }: { status: DisplayStatus; title?: string }) {
  const label = title ?? STATUS_LABEL[status];
  // Le title n'est pas lu par les lecteurs d'écran : le statut est aussi porté par un texte masqué.
  // Une question en attente porte un « ? » : la couleur seule ne suffit pas à la distinguer.
  if (status === 'waiting') {
    return (
      <span className="dot waiting ask-mark" title={label}>
        <span aria-hidden="true">?</span>
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span className={`dot ${status}`} title={label}>
      <span className="sr-only">{label}</span>
    </span>
  );
}
