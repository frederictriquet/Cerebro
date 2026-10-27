import { plural } from './format.ts';
import { href } from './route.ts';
import './findings.css';

export function FindingsLink({ sessionId, count, onNavigate }: {
  sessionId: string; count: number; onNavigate?: () => void;
}) {
  if (count < 1) return null;
  return <a className="findings-link" href={href(`#/s/${sessionId}/findings`)} onClick={onNavigate}
    title="Ouvrir les findings de review et sélectionner ceux à transformer en tâches">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h5" />
    </svg>
    {plural(count, 'finding')} de review à traiter
    <span aria-hidden="true">↗</span>
  </a>;
}
