import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { getAgentAvailability, type Tuning } from './agents.ts';
import type { Agent, Effort } from './db.ts';

const execFileAsync = promisify(execFile);
const DISCOVERY_TIMEOUT_MS = 20_000;
const REFRESH_MS = 60 * 60 * 1000;

export interface ModelChoice {
  value: string;
  label: string;
  description: string;
  efforts: Effort[];
}

// Choix proposés à la création d'une session. `efforts` : ceux du modèle par défaut de l'agent.
export interface AgentCatalog {
  models: ModelChoice[];
  efforts: Effort[];
  // Model used when none is chosen: the CLI default, always one of `models`; null when no model is listed.
  defaultModel: string | null;
}

const CLAUDE_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_ORDER: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// Repli quand la découverte échoue.
const FALLBACK: Record<Agent, AgentCatalog> = {
  claude: {
    models: [
      { value: 'opus', label: 'Opus', description: '', efforts: CLAUDE_EFFORTS },
      { value: 'sonnet', label: 'Sonnet', description: '', efforts: CLAUDE_EFFORTS },
      { value: 'haiku', label: 'Haiku', description: '', efforts: CLAUDE_EFFORTS },
    ],
    efforts: CLAUDE_EFFORTS,
    defaultModel: 'opus',
  },
  codex: { models: [], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultModel: null },
  grok: { models: [], efforts: ['low', 'medium', 'high', 'xhigh'], defaultModel: null },
};

const catalogs: Record<Agent, AgentCatalog> = { ...FALLBACK };
let pending: Promise<void> | null = null;

function isEffort(value: unknown): value is Effort {
  return EFFORT_ORDER.includes(value as Effort);
}

function sortEfforts(efforts: Effort[]): Effort[] {
  return EFFORT_ORDER.filter((e) => efforts.includes(e));
}

function modelEfforts(info: ModelInfo): Effort[] {
  return info.supportsEffort === false ? [] : [...(info.supportedEffortLevels ?? [])];
}

// Effort used when none is chosen: `high` when offered, otherwise the first level. Mirrored in web/src/LlmSelector.tsx.
export function defaultEffort(efforts: Effort[]): Effort | null {
  return efforts.includes('high') ? 'high' : (efforts[0] ?? null);
}

// Interroge la CLI `claude` installée (celle que lancent les sessions) via le SDK : une requête de
// contrôle, sans message envoyé au modèle. La ligne « default » donne les efforts du modèle par défaut.
async function discoverClaude(): Promise<AgentCatalog> {
  const { stdout } = await execFileAsync('which', ['claude']);
  let release = (): void => {};
  // Flux d'entrée qui ne produit rien : il garde la session ouverte jusqu'à release().
  // eslint-disable-next-line require-yield
  const prompt = (async function* () {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  })();
  const session = query({
    prompt,
    options: {
      cwd: homedir(),
      pathToClaudeCodeExecutable: stdout.trim(),
      persistSession: false,
      settingSources: ['user'],
    },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const infos = await Promise.race([
      session.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('délai dépassé')), DISCOVERY_TIMEOUT_MS);
      }),
    ]);
    const fallbackDefault = infos.find((info) => info.value === 'default');
    // Seulement les alias (opus, sonnet…), qui suivent la dernière version, pas les ids datés.
    const aliases = infos.filter((info) => info.value !== 'default' && !info.value.startsWith('claude-'));
    const models = aliases.map((info) => ({
      value: info.value,
      label: info.displayName,
      description: info.description,
      efforts: modelEfforts(info),
    }));
    if (models.length === 0) throw new Error('aucun modèle');
    // The alias resolving to the same model id as the CLI default row (e.g. `fable` for `default`).
    const defaultId = fallbackDefault?.resolvedModel;
    const defaultModel =
      aliases.find((info) => defaultId !== undefined && info.resolvedModel === defaultId)?.value ?? models[0]!.value;
    return {
      models,
      efforts: fallbackDefault === undefined ? CLAUDE_EFFORTS : modelEfforts(fallbackDefault),
      defaultModel,
    };
  } finally {
    clearTimeout(timer);
    session.close();
    release();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// `grok models` rafraîchit ~/.grok/models_cache.json (format non documenté, lu avec tolérance) et donne
// l'ordre d'affichage et le modèle par défaut ; le cache donne libellés et efforts par modèle.
async function discoverGrok(): Promise<AgentCatalog> {
  const { stdout } = await execFileAsync('grok', ['models'], { timeout: DISCOVERY_TIMEOUT_MS });
  const listed = [...stdout.matchAll(/^\s*[*-]\s+(\S+)/gm)].map((m) => m[1]!);
  const defaultModel = /^Default model:\s*(\S+)/m.exec(stdout)?.[1];
  const cache: unknown = JSON.parse(await readFile(join(homedir(), '.grok', 'models_cache.json'), 'utf8'));
  if (!isRecord(cache) || !isRecord(cache.models)) throw new Error('cache des modèles illisible');
  const entries = Object.entries(cache.models).flatMap(([id, entry]) => {
    const info = isRecord(entry) && isRecord(entry.info) ? entry.info : null;
    if (info === null || info.hidden === true) return [];
    const efforts =
      info.supports_reasoning_effort === true && Array.isArray(info.reasoning_efforts)
        ? sortEfforts(info.reasoning_efforts.map((e: unknown) => (isRecord(e) ? e.value : null)).filter(isEffort))
        : [];
    const value = typeof info.id === 'string' ? info.id : id;
    return [
      {
        value,
        label: typeof info.name === 'string' ? info.name : value,
        description: typeof info.description === 'string' ? info.description : '',
        efforts,
      },
    ];
  });
  // Ordre de `grok models` ; les modèles absents de sa sortie viennent ensuite.
  const rank = (value: string): number => {
    const i = listed.indexOf(value);
    return i === -1 ? listed.length : i;
  };
  const models = entries.sort((a, b) => rank(a.value) - rank(b.value));
  if (models.length === 0) throw new Error('aucun modèle');
  const fallbackDefault = models.find((m) => m.value === defaultModel) ?? models[0]!;
  return { models, efforts: fallbackDefault.efforts, defaultModel: fallbackDefault.value };
}

// `model = "…"` de premier niveau dans ~/.codex/config.toml, modèle lancé par défaut par codex.
async function readCodexDefaultModel(): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'), 'utf8');
  } catch {
    return null;
  }
  const firstTable = text.search(/^\s*\[/m);
  const topLevel = firstTable === -1 ? text : text.slice(0, firstTable);
  return (
    /^[ \t]*"?model"?[ \t]*=[ \t]*(?:"([^"\n]*)"|'([^'\n]*)')/m
      .exec(topLevel)
      ?.slice(1)
      .find((v) => v !== undefined) ?? null
  );
}

// `codex debug models` : catalogue JSON de la CLI installée (même source que `model/list` de
// `codex app-server`, plus léger). Défaut : celui de config.toml, sinon le premier visible.
async function discoverCodex(): Promise<AgentCatalog> {
  const [{ stdout }, configured] = await Promise.all([
    execFileAsync('codex', ['debug', 'models'], { timeout: DISCOVERY_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }),
    readCodexDefaultModel(),
  ]);
  const data: unknown = JSON.parse(stdout);
  if (!isRecord(data) || !Array.isArray(data.models)) throw new Error('sortie de `codex debug models` illisible');
  const models = data.models
    .filter((m): m is Record<string, unknown> => isRecord(m) && m.visibility === 'list' && typeof m.slug === 'string')
    .sort(
      (a, b) =>
        (typeof a.priority === 'number' ? a.priority : Infinity) -
        (typeof b.priority === 'number' ? b.priority : Infinity),
    )
    .map((m) => ({
      value: m.slug as string,
      label: typeof m.display_name === 'string' ? m.display_name : (m.slug as string),
      description: typeof m.description === 'string' ? m.description : '',
      efforts: Array.isArray(m.supported_reasoning_levels)
        ? sortEfforts(
            m.supported_reasoning_levels.map((l: unknown) => (isRecord(l) ? l.effort : null)).filter(isEffort),
          )
        : [],
    }));
  if (models.length === 0) throw new Error('aucun modèle');
  const fallbackDefault = models.find((m) => m.value === configured) ?? models[0]!;
  return { models, efforts: fallbackDefault.efforts, defaultModel: fallbackDefault.value };
}

const DISCOVERERS: Partial<Record<Agent, () => Promise<AgentCatalog>>> = {
  claude: discoverClaude,
  codex: discoverCodex,
  grok: discoverGrok,
};

export function refreshCatalog(): Promise<void> {
  // Agent non installé : pas de découverte, on garde le repli sans warning.
  pending ??= getAgentAvailability()
    .then((availability) =>
      Promise.all(
        Object.entries(DISCOVERERS)
          .filter(([agent]) => availability.some((a) => a.agent === agent && a.available))
          .map(([agent, discover]) =>
            discover()
              .then((catalog) => {
                catalogs[agent as Agent] = catalog;
              })
              .catch((error: unknown) => {
                console.warn(
                  `Catalogue ${agent} indisponible, liste par défaut : ${error instanceof Error ? error.message : String(error)}`,
                );
              }),
          ),
      ),
    )
    .then(() => {})
    .finally(() => {
      pending = null;
    });
  return pending;
}

export function startCatalogRefresh(): void {
  void refreshCatalog();
  setInterval(() => void refreshCatalog(), REFRESH_MS).unref();
}

/** Catalogue courant ; attend une découverte en cours pour ne pas servir le repli au démarrage. */
export async function getCatalog(): Promise<Record<Agent, AgentCatalog>> {
  if (pending !== null) await pending;
  return { ...catalogs };
}

export function catalogFor(agent: Agent): AgentCatalog {
  return catalogs[agent];
}

// model / effort facultatifs (null ou absents = défaut Cerebro), restreints au catalogue de l'agent.
// The result is always explicit: null resolves to the catalog default model, then to `defaultEffort`.
export function parseTuning(agent: Agent, body: Record<string, unknown>): Tuning | null {
  const catalog = catalogFor(agent);
  const model = (body.model ?? catalog.defaultModel) as string | null;
  let efforts = catalog.efforts;
  if (model !== null) {
    const choice = catalog.models.find((m) => m.value === model);
    if (choice === undefined) return null;
    efforts = choice.efforts;
  }
  const effort = body.effort ?? null;
  const level = efforts.find((e) => e === effort);
  if (effort !== null && level === undefined) return null;
  return { model, effort: level ?? defaultEffort(efforts) };
}
