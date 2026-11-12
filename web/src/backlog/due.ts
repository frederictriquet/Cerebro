// Échéances : dates calendaires AAAA-MM-JJ, sans heure ni fuseau. « Aujourd'hui » est la date locale du navigateur.

const pad = (n: number): string => String(n).padStart(2, '0');

export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function parts(iso: string): [number, number, number] {
  const [year = 0, month = 1, day = 1] = iso.split('-').map(Number);
  return [year, month, day];
}

function format(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDays(iso: string, days: number): string {
  const [year, month, day] = parts(iso);
  return format(new Date(Date.UTC(year, month - 1, day + days)));
}

// Un mois plus tard, ramené à la fin du mois d'arrivée quand le jour n'y existe pas (31 janvier → 28 février).
export function addMonths(iso: string, months: number): string {
  const [year, month, day] = parts(iso);
  const lastDay = new Date(Date.UTC(year, month - 1 + months + 1, 0)).getUTCDate();
  return format(new Date(Date.UTC(year, month - 1 + months, Math.min(day, lastDay))));
}

export type Postpone = { days: number } | { months: number };

// Repousser part de l'échéance, ou d'aujourd'hui quand elle est dépassée ou absente : repousser de 1 jour
// une échéance d'hier doit donner demain, pas aujourd'hui.
export function postponed(due: string | null, by: Postpone, today: string): string {
  const base = due !== null && due > today ? due : today;
  return 'days' in by ? addDays(base, by.days) : addMonths(base, by.months);
}

// Échéance croissante, sans échéance en dernier. Le tri de Array.sort étant stable, l'ordre d'origine
// (création) départage les échéances égales.
export function byDueDate(a: { dueDate: string | null }, b: { dueDate: string | null }): number {
  if (a.dueDate === b.dueDate) return 0;
  if (a.dueDate === null) return 1;
  if (b.dueDate === null) return -1;
  return a.dueDate < b.dueDate ? -1 : 1;
}

export function dueLabel(iso: string, today: string): string {
  const [year, month, day] = parts(iso);
  const date = new Date(Date.UTC(year, month - 1, day));
  const sameYear = year === Number(today.slice(0, 4));
  return date.toLocaleDateString('fr-FR', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
