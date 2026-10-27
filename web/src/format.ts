import type { Agent, Mode, Session, Status, WorkspaceMode } from '../../shared/types.ts';

// Statut affiché : une session inactive ou terminée depuis plus d'une heure passe « en sommeil »,
// signe qu'on n'en aura sans doute plus besoin ; ce sont celles que la purge supprime.
export type DisplayStatus = Status | 'dormant';

export const DORMANT_AFTER_MS = 60 * 60_000;

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  starting: 'Démarrage',
  running: 'En cours',
  waiting: 'En attente',
  idle: 'Inactif',
  exited: 'Terminé',
  dormant: 'En sommeil',
};

export function isDormant(session: Pick<Session, 'status' | 'updatedAt'> & Partial<Pick<Session, 'pendingFindings'>>, now: number): boolean {
  return !session.pendingFindings && (session.status === 'idle' || session.status === 'exited') && now - session.updatedAt >= DORMANT_AFTER_MS;
}

export function displayStatus(session: Pick<Session, 'status' | 'updatedAt'> & Partial<Pick<Session, 'pendingFindings'>>, now: number): DisplayStatus {
  return isDormant(session, now) ? 'dormant' : session.status;
}

export const MODE_LABEL: Record<Mode, string> = {
  auto: '⏵⏵ auto mode on',
  default: 'default (config de l’agent)',
  acceptEdits: '⏵⏵ accept edits on',
  plan: '⏸ plan mode on',
  bypass: '⏵⏵ bypass permissions on',
};

export function isAwaiting(session: Pick<Session, 'attention' | 'status'>): boolean {
  return session.attention || session.status === 'waiting';
}

export function needsAttention(session: Pick<Session, 'attention' | 'pendingFindings'>): boolean {
  return session.attention || session.pendingFindings > 0;
}

export const MODE_CHIP: Record<Mode, string> = {
  auto: '⏵⏵ auto',
  default: 'default',
  acceptEdits: '⏵⏵ accept edits',
  plan: '⏸ plan',
  bypass: '⏵⏵ bypass',
};

export const MODE_DESCRIPTION: Record<Mode, string> = {
  auto: 'Gestion automatique des autorisations par l’agent.',
  default: 'Utilise les autorisations définies dans la configuration de l’agent.',
  acceptEdits: 'Accepte automatiquement les modifications de fichiers. Avec Codex, exécute sans confirmation dans le sandbox du projet.',
  plan: 'Analyse et prépare un plan sans modifier les fichiers.',
  bypass: 'Exécute sans demander d’autorisation. Avec Codex, désactive également le sandbox.',
};

export const AGENT_LABEL: Record<Agent, string> = {
  claude: 'claude',
  codex: 'codex',
  grok: 'grok',
};

// Suffixe des boutons de lancement : rappelle où travailleront les nouvelles conversations du projet.
export const WORKSPACE_TARGET: Record<WorkspaceMode, string> = {
  isolated: 'dans un worktree',
  shared: 'dans le dossier du projet',
};

export function relativeTime(ts: number, now: number): string {
  const delta = Math.max(0, Math.round((now - ts) / 1000));
  if (delta < 45) return "à l'instant";
  const minutes = Math.round(delta / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  return `il y a ${days} j`;
}

export function sessionTitle(title: string): string {
  const t = title.trim();
  if(/^\[CEREBRO_EPIC_STEP\b/.test(t)){
    const epic=/de l[’']epic « ([^»]+) »/.exec(t)?.[1];
    return epic?`Étape de l’epic « ${epic} »`:'Étape d’epic';
  }
  return t.length > 0 ? t : 'Session';
}
