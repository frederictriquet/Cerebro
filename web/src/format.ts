import type { Agent, Mode, Session, Status } from './types.ts';

export const STATUS_LABEL: Record<Status, string> = {
  starting: 'Démarrage',
  running: 'En cours',
  waiting: 'En attente',
  idle: 'Inactif',
  exited: 'Terminé',
};

export const MODE_LABEL: Record<Mode, string> = {
  default: "Défaut (config de l'agent)",
  acceptEdits: 'Accepter les éditions',
  plan: 'Plan / lecture seule',
  bypass: 'Bypass (aucune confirmation)',
};

export function isAwaiting(session: Pick<Session, 'attention' | 'status'>): boolean {
  return session.attention || session.status === 'waiting';
}

export const AGENT_LABEL: Record<Agent, string> = {
  claude: 'claude',
  codex: 'codex',
  grok: 'grok',
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
  return t.length > 0 ? t : 'Session';
}
