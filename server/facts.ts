import type { CerebroDatabase } from './db.ts';
import { collectMachines, type MachineState } from './state.ts';

export const FACT_HELP = 'Consultations sans agent : `? etat sessions|taches|epics|machines|avancement|blocages|activites [projet="nom exact ou id"] [machine="nom exact"] [statut=...] [epic="id ou titre exact"] [compter]`. Statuts sessions : starting/running/waiting/idle/exited ; tâches : todo/started/done/restantes.';
type Entity = 'sessions' | 'taches' | 'epics' | 'machines' | 'avancement' | 'blocages' | 'activites';
export interface FactQuery { entity: Entity; project?: string; machine?: string; status?: string; epic?: string; count: boolean }
const normalized = (s: string): string => s.toLocaleLowerCase('fr-FR').normalize('NFD').replace(/\p{Diacritic}/gu, '');
const exact = (value: string, id: string, name: string): boolean => value === id || normalized(value) === normalized(name);
export function parseFactQuery(question: string): FactQuery | string | null {
  const natural: Record<string, FactQuery> = {
    'combien de taches restent': { entity: 'taches', status: 'restantes', count: true },
    'combien de taches restantes': { entity: 'taches', status: 'restantes', count: true },
    'combien de taches reste-t-il': { entity: 'taches', status: 'restantes', count: true },
    'liste des sessions en attente': { entity: 'sessions', status: 'waiting', count: false },
    'quelles sessions sont en attente': { entity: 'sessions', status: 'waiting', count: false },
    'sessions en attente': { entity: 'sessions', status: 'waiting', count: false },
  };
  const n = normalized(question).trim().replace(/\s*\?$/, '');
  if (Object.hasOwn(natural, n)) return natural[n];
  if (!/^etat(?:\s|$)/.test(n)) return null;
  const match = /^\S+\s+(sessions|taches|epics|machines|avancement|blocages|activites)(?=\s|$)/.exec(n);
  if (!match) return FACT_HELP;
  const query: FactQuery = { entity: match[1] as Entity, count: false };
  let rest = question.trim().slice(match[0].length).trim();
  const seen = new Set<string>();
  while (rest) {
    if (rest === 'compter') { query.count = true; break; }
    const option = /^(projet|machine|statut|epic)=(?:"([^"\n]+)"|([^\s"]+))(?:\s+|$)/.exec(rest);
    if (!option || seen.has(option[1])) return FACT_HELP;
    seen.add(option[1]);
    const key = ({ projet: 'project', machine: 'machine', statut: 'status', epic: 'epic' } as const)[option[1] as 'projet' | 'machine' | 'statut' | 'epic'];
    query[key] = option[2] ?? option[3];
    rest = rest.slice(option[0].length).trim();
  }
  const allowed = query.entity === 'sessions' ? ['starting', 'running', 'waiting', 'idle', 'exited'] : ['todo', 'started', 'done', 'restantes'];
  if (query.status && (!['sessions', 'taches', 'blocages', 'avancement'].includes(query.entity) || !allowed.includes(query.status))) return FACT_HELP;
  if (query.epic && ['sessions', 'machines'].includes(query.entity)) return FACT_HELP;
  if (query.entity === 'machines' && query.project) return FACT_HELP;
  return query;
}
const short = (s: string): string => s.replace(/[\r\n]+/g, ' ').slice(0, 240);
const time = (n: number): string => new Date(n).toISOString();

export function renderFacts(query: FactQuery, states: MachineState[]): string {
  const filtered = states.filter(s => !query.machine || normalized(s.ok ? s.data.machine : s.machine) === normalized(query.machine));
  if (!filtered.length) return 'Machine introuvable (nom exact attendu).';
  const lines: string[] = [];
  let total = 0;
  let matches = 0;
  for (const state of filtered) {
    if (!state.ok) { lines.push(`${state.machine} : indisponible (${state.error}). Résultats incomplets.`); continue; }
    const data = state.data;
    if (query.entity === 'machines') { lines.push(`${data.machine} : joignable, ${data.projects.length} projet(s).`); total++; matches++; continue; }
    const projects = data.projects.filter(p => !query.project || exact(query.project, p.id, p.name));
    if (query.project && projects.length > 1) return `Projet ambigu sur ${data.machine} : utilisez son identifiant.\n${FACT_HELP}`;
    for (const project of projects) {
      let epics = data.epics.filter(e => e.projectId === project.id && (!query.epic || exact(query.epic, e.id, e.title)));
      if (query.epic && !epics.length) continue;
      if (query.epic && epics.length > 1) return `Epic ambigu : utilisez son identifiant.\n${FACT_HELP}`;
      matches++;
      const tasks = data.tasks.filter(t => t.projectId === project.id && (!query.epic || epics.some(e => e.id === t.epicId)));
      const selected = tasks.filter(t => !query.status || (query.status === 'restantes' ? t.status !== 'done' : t.status === query.status));
      const sessions = data.sessions.filter(s => s.projectId === project.id && (!query.status || s.status === query.status));
      const header = `${data.machine} / ${project.name}`;
      const blockers = (ids: string[]): string[] => ids.flatMap(id => {
        // Dependencies outside the selected epic remain visible and count as blockers.
        const task = data.tasks.find(t => t.id === id && t.projectId === project.id);
        return task?.status === 'done' ? [] : [`${id} (${task?.status ?? 'introuvable'})`];
      });
      if (query.entity === 'sessions') {
        total += sessions.length;
        lines.push(`${header} : ${sessions.length} session(s).`);
        if (!query.count) lines.push(...sessions.map(s => `• ${s.id} — ${short(s.title)} : ${s.status}${s.attentionReason ? ` (${short(s.attentionReason)})` : ''}, activité enregistrée ${time(s.updatedAt)}`));
      } else if (query.entity === 'taches' || query.entity === 'blocages') {
        const rows = query.entity === 'blocages' ? selected.filter(t => t.status !== 'done' && blockers(t.dependsOn).length) : selected;
        total += rows.length;
        lines.push(`${header} : ${rows.length} tâche(s).`);
        if (!query.count) lines.push(...rows.map(t => `• ${t.id} — ${short(t.text)} : statut déclaré ${t.status}${blockers(t.dependsOn).length ? ` ; dépendances bloquantes : ${blockers(t.dependsOn).join(', ')}` : ''}`));
      } else if (query.entity === 'epics' || query.entity === 'avancement') {
        if (query.entity === 'avancement' && !query.epic) {
          const done = selected.filter(t => t.status === 'done').length;
          lines.push(`${header} : ${done}/${selected.length} tâches déclarées done (${selected.length ? Math.floor(100 * done / selected.length) : 0} %).`);
        }
        total += epics.length;
        for (const epic of epics) {
          const members = selected.filter(t => t.epicId === epic.id);
          lines.push(`${header} / ${epic.title} (${epic.id}) : ${members.filter(t => t.status === 'done').length}/${members.length} déclarées done ; ${members.filter(t => t.status !== 'done' && blockers(t.dependsOn).length).length} bloquée(s).`);
        }
      } else {
        const records = [
          ...tasks.map(t => ({ at: t.updatedAt, text: `tâche ${t.id} : statut déclaré ${t.status}` })),
          ...data.sessions.filter(s => s.projectId === project.id).map(s => ({ at: s.updatedAt, text: `session ${s.id} : ${s.status}` })),
          ...epics.map(e => ({ at: e.updatedAt, text: `epic ${e.id} : ${short(e.title)}` })),
        ].sort((a,b) => b.at-a.at);
        total += records.length;
        lines.push(`${header} : dernières modifications enregistrées (état courant, pas un historique complet).`);
        if (!query.count) lines.push(...records.map(r => `• ${time(r.at)} — ${r.text}`));
      }
    }
  }
  if (!matches) lines.push('Aucun projet ou epic correspondant (nom exact ou identifiant attendu).');
  if (query.count) lines.unshift(`Total joignable : ${total}.`);
  if (query.entity !== 'machines' && query.entity !== 'sessions') lines.push('« done » est un statut déclaré ; la validation effective du travail n’est pas attestée par ces données.');
  return lines.join('\n');
}

/** null means open-ended question: only those use the existing LLM path. */
export async function answerFactQuestion(db: CerebroDatabase, question: string): Promise<string | null> {
  const query = parseFactQuery(question);
  if (query === null || typeof query === 'string') return query;
  return renderFacts(query, await collectMachines(db));
}
