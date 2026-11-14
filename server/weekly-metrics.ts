import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { isRecord } from '../shared/parse.ts';
import {
  parseWeeklySyntheses,
  type WeeklyMetricsMachine,
  type WeeklyMetricsReport,
  type WeeklySyntheses,
} from '../shared/weekly-metrics.ts';
import { loadRemotes, MACHINE_NAME } from './config.ts';
import { routeErrors } from './routes-util.ts';
import { defaultTranscriptRoots } from './transcripts.ts';
import { errorMessage, isEnoent } from './util.ts';

const WEEK_FILE = /^\d{4}-W\d{2}\.json$/;

/** Folder name the weekly script gives a remote machine: lower case, other characters folded into `-`. */
export function machineSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** JSON object read from `path`, or undefined with the reason added to `problems`. A missing file is null. */
async function readObject(path: string, problems: string[]): Promise<Record<string, unknown> | null | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(value) || Array.isArray(value)) throw new Error('objet JSON attendu');
    return value;
  } catch (cause) {
    if (isEnoent(cause)) return null;
    problems.push(`${path} : ${errorMessage(cause)}`);
    return undefined;
  }
}

/** Week records of one folder, oldest first; null when the folder does not exist. */
async function readWeeks(dir: string, problems: string[]): Promise<Record<string, unknown>[] | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (cause) {
    if (isEnoent(cause)) return null;
    throw cause;
  }
  const weeks: Record<string, unknown>[] = [];
  for (const name of names.filter((n) => WEEK_FILE.test(n)).sort()) {
    const week = await readObject(join(dir, name), problems);
    if (week) weeks.push(week);
  }
  return weeks;
}

/** Comments of `syntheses.json`; null when the file is missing, or unreadable (reason added to `problems`). */
async function readSyntheses(path: string, problems: string[]): Promise<WeeklySyntheses | null> {
  const value = await readObject(path, problems);
  if (!value) return null;
  const syntheses = parseWeeklySyntheses(value);
  if (!syntheses) {
    problems.push(`${path} : synthèses mal formées (attendu : semaine, redige_le et textes, tous en texte)`);
  }
  return syntheses;
}

/** Records of this machine (`<dir>/weeks`) and of each copied remote machine (`<dir>/machines/<slug>/weeks`). */
export async function readWeeklyMetrics(dir: string): Promise<WeeklyMetricsReport> {
  const problems: string[] = [];
  const machines: WeeklyMetricsMachine[] = [];
  const local = await readWeeks(join(dir, 'weeks'), problems);
  if (local) {
    const manual = await readObject(join(dir, 'manual.json'), problems);
    const syntheses = await readSyntheses(join(dir, 'syntheses.json'), problems);
    machines.push({ id: 'local', name: MACHINE_NAME, weeks: local, manual: manual ?? {}, syntheses });
  }
  let slugs: string[] = [];
  try {
    slugs = (await readdir(join(dir, 'machines'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    if (!isEnoent(cause)) throw cause;
  }
  const remotes = loadRemotes();
  for (const slug of slugs) {
    const weeks = await readWeeks(join(dir, 'machines', slug, 'weeks'), problems);
    if (!weeks) continue;
    const name = remotes.find((remote) => machineSlug(remote.name) === slug)?.name ?? slug;
    const syntheses = await readSyntheses(join(dir, 'machines', slug, 'syntheses.json'), problems);
    machines.push({ id: slug, name, weeks, manual: {}, syntheses });
  }
  return { directory: dir, machines, problems };
}

const { attempt } = routeErrors(500);

export function registerWeeklyMetricsRoutes(
  app: FastifyInstance,
  dir = join(defaultTranscriptRoots().claude, 'metrics'),
): void {
  app.get('/api/weekly-metrics', (_request, reply) => attempt(reply, () => readWeeklyMetrics(dir)));
}
