import type { EpicRun, SessionTaskStatus } from '../../shared/backlog.ts';
import type { Agent, CouncilStatus, Mode, Session, Status, Task, WorkspaceMode } from '../../shared/types.ts';

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

// Libellés capitalisés : passer par toLowerCase() pour les insérer dans une phrase.
export const COUNCIL_STATUS_LABEL: Record<CouncilStatus, string> = {
  running: 'En cours',
  succeeded: 'Terminé',
  failed: 'Échec',
  cancelled: 'Annulé',
  interrupted: 'Interrompu',
};

export const TASK_STATUS_LABEL: Record<Task['status'], string> = {
  todo: 'À faire',
  started: 'En cours',
  done: 'Terminée',
};

export const EPIC_RUN_STATUS_LABEL: Record<EpicRun['status'], string> = {
  running: 'en cours',
  'waiting-validation': 'en attente de validation',
  blocked: 'bloqué',
  failed: 'en échec',
  stopped: 'arrêté',
  succeeded: 'terminé',
};

export const SESSION_TASK_STATUS_LABEL: Record<SessionTaskStatus, string> = {
  todo: 'À faire', in_progress: 'En cours', blocked: 'Bloquée', done: 'Terminée', cancelled: 'Annulée',
};

// État d'ensemble des sous-tâches d'une session, résumé dans son en-tête.
export const SESSION_TASKS_STATE_LABEL: Record<SessionTaskStatus | 'empty', string> = {
  todo: 'À faire', in_progress: 'En cours', blocked: 'Blocage',
  done: 'Tous les objectifs sont terminés ou annulés', cancelled: 'Tous les objectifs sont annulés', empty: 'Aucune sous-tâche',
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

export interface AttentionCounts {
  /** Sessions réclamant l'attention, tous motifs confondus (voir needsAttention). */
  total: number;
  /** Parmi elles, celles en attente d'une réponse ou d'une autorisation. */
  waiting: number;
  /** Findings en attente de traitement, toutes sessions confondues. */
  pendingFindings: number;
}

// Seul décompte de l'attention : favicon, sidebar, onglets de projet, machines et groupes d'epic doivent concorder.
export function attentionCounts(sessions: readonly Pick<Session, 'attention' | 'pendingFindings' | 'status'>[]): AttentionCounts {
  const counts: AttentionCounts = { total: 0, waiting: 0, pendingFindings: 0 };
  for (const session of sessions) {
    counts.pendingFindings += session.pendingFindings;
    if (!needsAttention(session)) continue;
    counts.total += 1;
    if (session.status === 'waiting') counts.waiting += 1;
  }
  return counts;
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

// Accord en nombre à la française : 0 et 1 restent au singulier. `zeroPlural` met 0 au
// pluriel pour les compteurs qui s'affichent aussi à zéro (« 0 fichiers modifiés »).
export function pluralize(count: number, singular: string, plural = `${singular}s`, { zeroPlural = false } = {}): string {
  return count > 1 || (zeroPlural && count === 0) ? plural : singular;
}

// « 3 fichiers », « 1 fichier modifié » : le nombre suivi du libellé accordé.
export function plural(count: number, singular: string, pluralForm?: string, options?: { zeroPlural?: boolean }): string {
  return `${count} ${pluralize(count, singular, pluralForm, options)}`;
}

// Date et heure courtes : « 26 oct., 14:05 ».
export function formatDateTime(at: number | string): string {
  return new Date(at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

// Durée lisible. À la seconde (« 2 min 05 s ») pour un chronomètre, sinon à la minute
// (« 45 min », « 3 h 05 », « 2 j 4 h ») pour une échéance.
export function formatDuration(ms: number, precision: 'seconds' | 'minutes' = 'minutes'): string {
  if (precision === 'seconds') {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    return minutes === 0 ? `${seconds} s` : `${minutes} min ${pad2(seconds % 60)} s`;
  }
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${pad2(minutes % 60)}`;
  return `${Math.floor(hours / 24)} j ${hours % 24} h`;
}

// Texte ramené sur une ligne et coupé à `max` caractères, points de suspension compris.
export function truncate(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function sessionTitle(title: string): string {
  const t = title.trim();
  if(/^\[CEREBRO_EPIC_STEP\b/.test(t)){
    const epic=/de l[’']epic « ([^»]+) »/.exec(t)?.[1];
    return epic?`Étape de l’epic « ${epic} »`:'Étape d’epic';
  }
  return t.length > 0 ? t : 'Session';
}

// Message à afficher pour une erreur interceptée : String(cause) préfixerait « ApiError: » ou « Error: ».
// Hors Error, le libellé de repli s'il est fourni, sinon la valeur convertie en texte.
export function errorMessage(cause: unknown, fallback?: string): string {
  if (cause instanceof Error) return cause.message;
  return fallback ?? String(cause);
}
