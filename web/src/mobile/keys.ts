import type { Session } from '../../../shared/types.ts';

export interface QuickKey {
  label: string;
  data: string;
  name?: string;
  confirm?: boolean;
}

export const QUICK_KEYS: readonly QuickKey[] = [
  { label: 'Entrée', data: '\r' },
  { label: 'Échap', data: '\x1b' },
  { label: '↑', data: '\x1b[A', name: 'Flèche haut' },
  { label: '↓', data: '\x1b[B', name: 'Flèche bas' },
  { label: '1', data: '1' },
  { label: '2', data: '2' },
  { label: '3', data: '3' },
  { label: 'y', data: 'y' },
  { label: 'n', data: 'n' },
  { label: 'Ctrl+C', data: '\x03', confirm: true },
];

const DIGITS = ['1', '2', '3'];

/**
 * Keys that answer what the session waits for, shown first, and the others, still shown. [SPEC: vue mobile, écran de
 * session] A question takes its option numbers, a permission the numbered menu of the agent's dialog, any other wait
 * Enter, Escape, y and n; a session that waits for nothing has no first group. Ctrl+C is never first.
 */
export function quickKeyGroups(session: Pick<Session, 'status' | 'attentionDetail'>): {
  now: QuickKey[];
  other: QuickKey[];
} {
  let labels: string[] = [];
  if (session.status === 'waiting') {
    const detail = session.attentionDetail;
    if (detail?.kind === 'questions') {
      const options = detail.questions[0]?.options.length ?? DIGITS.length;
      labels = [...DIGITS.slice(0, Math.max(1, options)), 'Entrée', 'Échap'];
    } else if (detail?.kind === 'permission') {
      labels = [...DIGITS, 'Entrée', 'Échap'];
    } else {
      labels = ['Entrée', 'Échap', 'y', 'n'];
    }
  }
  const now = labels.flatMap((label) => QUICK_KEYS.filter((key) => key.label === label));
  return { now, other: QUICK_KEYS.filter((key) => !now.includes(key)) };
}
