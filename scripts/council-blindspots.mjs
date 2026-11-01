#!/usr/bin/env node
// Relevé des angles morts des derniers councils, en lecture seule et sans aucun appel LLM. Pour chaque run, il affiche
// reviews[].blindSpot, reviews[].missed (REVIEW_SCHEMA, server/council.ts) et chaque puce de synthesis.blindSpots.
// Chaque occurrence porte une référence stable (<run>/R2.missed, <run>/S3) pour la classer ensuite à la main.
// Usage : node --disable-warning=ExperimentalWarning scripts/council-blindspots.mjs [base.db] [--limit N] [--json]
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HELP = `Usage : council-blindspots.mjs [base.db] [--limit N] [--json]

Relève les angles morts des N derniers councils, les plus récents d'abord : reviews[].blindSpot,
reviews[].missed et chaque puce de synthesis.blindSpots. Aucun appel LLM.
La base est ouverte en lecture seule. Par défaut : $CEREBRO_DATA_DIR/cerebro.db, sinon ~/.cerebro/cerebro.db.
Travaillez de préférence sur une copie :
  sqlite3 -readonly ~/.cerebro/cerebro.db ".backup /tmp/cerebro-copie.db"

  --limit N    nombre de runs lus (20 par défaut)
  --json       sortie JSON au lieu du Markdown
  --help, -h   cette aide
`;

// En dessous, la règle « présent dans au moins un tiers des runs » ne distingue presque rien.
const MIN_RELIABLE_RUNS = 10;
const QUESTION_EXCERPT = 300;

const FIELDS = [
  ['blindSpot', 'angle mort'],
  ['missed', 'ce que tous ont manqué'],
];

process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

function parseArgs(args) {
  const options = {
    path: join(process.env.CEREBRO_DATA_DIR ?? join(homedir(), '.cerebro'), 'cerebro.db'),
    limit: 20,
    json: false,
  };
  let pathGiven = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--json') options.json = true;
    else if (arg === '--limit') {
      const limit = Number(args.shift());
      if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit attend un entier positif.');
      options.limit = limit;
    } else if (!arg.startsWith('-') && !pathGiven) {
      options.path = arg;
      pathGiven = true;
    } else throw new Error(`Argument inattendu : ${arg}`);
  }
  return options;
}

// Les plus récents d'abord, dans l'ordre de listCouncilRuns (server/db.ts).
function readRuns(path, limit) {
  // readOnly : SQLite refuse toute écriture et ne crée pas de base absente.
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT r.data, p.name AS project FROM council_runs r LEFT JOIN projects p ON p.id = r.project_id
        ORDER BY json_extract(r.data, '$.startedAt') DESC, r.rowid DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({ ...JSON.parse(row.data), projectName: row.project }));
  } finally {
    db.close();
  }
}

// Une occurrence par puce ; une ligne sans puce prolonge la précédente.
function bulletItems(markdown) {
  const items = [];
  for (const line of markdown.split('\n')) {
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) items.push(bullet[1].trim());
    else if (line.trim() === '') continue;
    else if (items.length) items[items.length - 1] += ` ${line.trim()}`;
    else items.push(line.trim());
  }
  return items;
}

function occurrences(run) {
  const prefix = run.id.slice(0, 8);
  const names = new Map(run.advisors.map((advisor) => [advisor.personaId, advisor.name]));
  const found = [];
  (run.reviews ?? []).forEach((review, index) => {
    for (const [field, label] of FIELDS) {
      const text = review[field]?.trim();
      if (!text) continue;
      const author = names.get(review.advisorId) ?? review.advisorId;
      found.push({ ref: `${prefix}/R${index + 1}.${field}`, source: `relecture de ${author}, ${label}`, text });
    }
  });
  bulletItems(run.synthesis?.blindSpots ?? '').forEach((text, index) =>
    found.push({ ref: `${prefix}/S${index + 1}`, source: 'synthèse, angles morts', text }),
  );
  return found;
}

function formatDate(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function excerpt(text, length) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function summary(run) {
  return {
    id: run.id,
    startedAt: formatDate(run.startedAt),
    status: run.status,
    origin: run.origin,
    project: run.projectName ?? null,
    question: run.question,
    advisors: run.advisors.map(({ name, agent, model }) => ({ name, agent, model })),
    occurrences: occurrences(run),
  };
}

function markdown(path, limit, runs) {
  const total = runs.reduce((sum, run) => sum + run.occurrences.length, 0);
  const lines = [
    `# Angles morts des councils`,
    '',
    `Base : ${path} (lecture seule). ${runs.length} run(s) lu(s) sur ${limit} demandés, ${total} occurrence(s).`,
  ];
  if (runs.length < MIN_RELIABLE_RUNS)
    lines.push(`Attention : moins de ${MIN_RELIABLE_RUNS} runs, la règle du tiers est peu fiable.`);
  runs.forEach((run, index) => {
    const advisors = run.advisors.map((advisor) => `${advisor.name} (${advisor.agent} · ${advisor.model ?? 'défaut'})`);
    lines.push(
      '',
      `## ${index + 1}. ${run.startedAt} · ${run.id.slice(0, 8)} · ${run.status} · ${run.project ?? 'hors projet'}`,
      '',
      `> ${excerpt(run.question, QUESTION_EXCERPT)}`,
      '',
      `Conseillers : ${advisors.join(', ')}.`,
      '',
      ...(run.occurrences.length === 0
        ? ['Aucun angle mort enregistré.']
        : run.occurrences.map((occurrence) => `- \`${occurrence.ref}\` ${occurrence.source} : ${occurrence.text}`)),
    );
  });
  return `${lines.join('\n')}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    process.stdout.write(HELP);
    return;
  }
  const runs = readRuns(options.path, options.limit).map(summary);
  process.stdout.write(
    options.json
      ? `${JSON.stringify({ database: options.path, runs }, null, 2)}\n`
      : markdown(options.path, options.limit, runs),
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`council-blindspots : ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
