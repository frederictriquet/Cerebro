import { useState } from 'react';
import type { Finding, SavedReport } from '../../server/findings.ts';
import { api } from './api.ts';
import { href } from './route.ts';
import { useStore } from './store.tsx';
import type { Session } from './types.ts';
import './findings.css';

const SEVERITY: Record<Finding['severity'], string> = {
  critical: 'Critique', high: 'Élevée', medium: 'Moyenne', low: 'Faible',
};

export function FindingsNotice({ reports, expanded, onToggle }: {
  reports: SavedReport[]; expanded: boolean; onToggle: () => void;
}) {
  if (!reports.length) return null;
  const total = reports.reduce((count, report) => count + report.findings.length, 0);
  const remaining = reports.reduce((count, report) => count + report.findings.filter(f => !report.imported?.[f.id]).length, 0);
  return <button type="button" className="findings-notice" onClick={onToggle}
    aria-expanded={expanded} aria-controls={expanded ? 'session-findings' : undefined}>
    <span className="findings-notice-icon" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h5" />
      </svg>
    </span>
    <span className="findings-notice-copy">
      <strong>{total} finding{total > 1 ? 's' : ''} de review disponible{total > 1 ? 's' : ''}</strong>
      <span>{reports.length} rapport{reports.length > 1 ? 's' : ''} · {remaining ? `${remaining} à examiner pour le backlog` : 'Tous les findings sont enregistrés dans le backlog'}</span>
    </span>
    <span className="findings-notice-action">{expanded ? 'Masquer les findings' : 'Examiner les findings'} <span aria-hidden="true">{expanded ? '▴' : '▾'}</span></span>
  </button>;
}

export function FindingsPanel({ sessionId, epic, reports, refresh }: {
  sessionId: string; epic: Session['epic']; reports: SavedReport[]; refresh: () => Promise<void>;
}) {
  const { epics } = useStore();
  const sourceEpic = epics.find(item => item.id === epic?.id);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [destinations, setDestinations] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [raw, setRaw] = useState('');
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null);
    try { await action(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="findings-panel">
    <div className="findings-panel-heading">
      <h2>Résultats de la review</h2>
      <p>Examinez les constats, puis sélectionnez ceux à transformer en tâches dans le backlog.</p>
    </div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {reports.map(report => {
      const available = report.findings.filter(f => !report.imported?.[f.id]);
      const selected = available.filter(f => chosen.has(`${report.id}:${f.id}`));
      const allSelected = available.length > 0 && selected.length === available.length;
      const destination = report.epicId ?? (Object.hasOwn(destinations, report.id) ? destinations[report.id] : sourceEpic?.id ?? null);
      const targetEpic = epics.find(item => item.id === destination);
      return <section className="finding-report" key={report.id} aria-labelledby={`report-${report.id}`}>
        <header className="finding-report-header">
          <div>
            <h3 id={`report-${report.id}`}>{report.title}</h3>
            <p className="meta">{report.findings.length} finding{report.findings.length > 1 ? 's' : ''} · <time dateTime={new Date(report.createdAt).toISOString()}>{new Date(report.createdAt).toLocaleString('fr-FR')}</time></p>
          </div>
          {available.length ? <button type="button" className="btn" disabled={busy} onClick={() => setChosen(previous => {
            const next = new Set(previous);
            available.forEach(f => { const key = `${report.id}:${f.id}`; if (allSelected) next.delete(key); else next.add(key); });
            return next;
          })}>{allSelected ? 'Tout désélectionner' : 'Tout sélectionner'}</button> : null}
        </header>
        <div className="finding-cards">
          {report.findings.map(f => {
            const key = `${report.id}:${f.id}`;
            const imported = !!report.imported?.[f.id];
            const checked = !imported && chosen.has(key);
            return <article key={f.id} className={`finding-card${checked ? ' selected' : ''}${imported ? ' imported' : ''}`}>
              <div className="finding-card-meta">
                <span className="finding-severity" data-severity={f.severity}>Gravité {SEVERITY[f.severity].toLowerCase()}</span>
                <code>{f.file}:{f.line}</code>
                {imported ? <span className="finding-imported">✓ Dans le backlog</span> : null}
              </div>
              <h4><label className="finding-choice">
                <input type="checkbox" checked={checked} disabled={imported || busy} onChange={event => {
                  const checked = event.target.checked;
                  setChosen(previous => { const next = new Set(previous); if (checked) next.add(key); else next.delete(key); return next; });
                }} />
                <span>{f.title}</span>
              </label></h4>
              <dl className="finding-details">
                <div className="finding-problem"><dt>Problème</dt><dd>{f.problem}</dd></div>
                <div><dt>Scénario concret</dt><dd>{f.scenario}</dd></div>
                <div><dt>Correctif attendu</dt><dd>{f.expectedFix}</dd></div>
              </dl>
              {f.dependsOn.length || f.taskDependencies.length ? <div className="finding-dependencies">
                <strong>Prérequis</strong>
                {f.dependsOn.length ? <p>À sélectionner aussi, sauf si déjà enregistrés : {f.dependsOn.map(id => report.findings.find(item => item.id === id)?.title ?? id).join(' ; ')}.</p> : null}
                {f.taskDependencies.length ? <p>Tâches du backlog : {f.taskDependencies.join(', ')}</p> : null}
              </div> : null}
            </article>;
          })}
        </div>
        <footer className="finding-report-footer">
          <span role="status">{available.length ? `${selected.length} finding${selected.length > 1 ? 's' : ''} sélectionné${selected.length > 1 ? 's' : ''} sur ${available.length}` : 'Tous les findings de ce rapport sont dans le backlog.'}</span>
          <div className="finding-import-actions">
            <div className="finding-report-routing">
              {report.epicId ? <p>Destination : {targetEpic ? <a href={href(`#/p/${targetEpic.projectId}`)}>Epic « {targetEpic.title} »</a> : 'epic supprimé'}</p> : <label>
                Destination des tâches
                <select value={destination ?? ''} disabled={busy} onChange={event => {
                  const value = event.target.value || null;
                  setDestinations(previous => ({ ...previous, [report.id]: value }));
                }}>
                  {sourceEpic ? <option value={sourceEpic.id}>À la suite de l’epic « {sourceEpic.title} »</option> : null}
                  <option value="">Nouvel epic</option>
                </select>
              </label>}
            </div>
            {available.length ? <button type="button" className="btn primary" disabled={busy || !selected.length} onClick={() => void run(async () => {
              await api(`/api/sessions/${sessionId}/findings/${report.id}/import`, { method: 'POST', body: JSON.stringify({ selected: selected.map(f => f.id), epicId: destination }) });
            })}>{busy ? 'Enregistrement…' : destination ? 'Ajouter la sélection à cet epic' : 'Enregistrer la sélection dans un nouvel epic'}</button> : null}
          </div>
          {sourceEpic && targetEpic?.id === sourceEpic.id ? <p className="hint">
            Les nouvelles tâches attendront les étapes déjà présentes. Traitez ensuite l’epic pour poursuivre dans son worktree ;
            si une exécution est en cours, utilisez « Reprendre et recalculer ».
          </p> : null}
        </footer>
      </section>;
    })}
    <details className="findings-json">
      <summary>Importer un rapport JSON structuré</summary>
      <label>Rapport JSON<textarea rows={8} value={raw} disabled={busy} onChange={event => setRaw(event.target.value)} /></label>
      <button type="button" className="btn" disabled={busy || !raw.trim()} onClick={() => void run(async () => {
        await api(`/api/sessions/${sessionId}/findings`, { method: 'POST', body: JSON.stringify(JSON.parse(raw)) });
        setRaw('');
      })}>Enregistrer le rapport</button>
    </details>
  </div>;
}
