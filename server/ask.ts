import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadRemotes, MACHINE_NAME, type RemoteMachine } from './config.ts';
import type { CerebroDatabase, Epic, Project, Session, Task } from './db.ts';

const execFileAsync = promisify(execFile);

const REMOTE_TIMEOUT_MS = 5_000;
const ANSWER_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_TURNS = 25;
const TEXT_LIMIT = 600;
// Ended sessions only matter as recent history.
const RECENT_EXITED_SESSIONS = 5;
// Read-only: a question never changes a project.
const TOOLS = ['Read', 'Glob', 'Grep'];

interface MachineData {
  machine: string;
  projects: Project[];
  sessions: Session[];
  tasks: Task[];
  epics: Epic[];
}

function truncate(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;
}

function date(value: number): string {
  return new Date(value).toISOString().slice(0, 16).replace('T', ' ');
}

function snapshot(data: MachineData): unknown {
  return {
    machine: data.machine,
    projects: data.projects.map((project) => {
      const sessions = data.sessions.filter((session) => session.projectId === project.id);
      const active = sessions.filter((session) => session.status !== 'exited');
      const exited = sessions.filter((session) => session.status === 'exited')
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, RECENT_EXITED_SESSIONS);
      const epics = data.epics.filter((epic) => epic.projectId === project.id);
      return {
        name: project.name,
        path: project.path,
        sessions: [...active, ...exited].map((session) => ({
          id: session.id,
          title: session.title,
          agent: session.agent,
          status: session.status,
          ...(session.attentionReason === null ? {} : { attention: session.attentionReason }),
          prompt: truncate(session.prompt),
          updatedAt: date(session.updatedAt),
        })),
        epics: epics.map((epic) => ({ id: epic.id, title: epic.title, description: truncate(epic.description) })),
        tasks: data.tasks.filter((task) => task.projectId === project.id).map((task) => ({
          id: task.id,
          status: task.status,
          text: truncate(task.text),
          ...(task.epicId === null ? {} : { epic: epics.find((epic) => epic.id === task.epicId)?.title ?? task.epicId }),
          ...(task.dependsOn.length === 0 ? {} : { dependsOn: task.dependsOn }),
          updatedAt: date(task.updatedAt),
        })),
      };
    }),
  };
}

async function fetchRemote<T>(remote: RemoteMachine, path: string): Promise<T> {
  const url = new URL(remote.url);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
  const response = await fetch(url, {
    headers: remote.token === undefined ? {} : { authorization: `Bearer ${remote.token}` },
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} sur ${path}`);
  return await response.json() as T;
}

async function remoteData(remote: RemoteMachine): Promise<MachineData> {
  const [projects, sessions, tasks, epics] = await Promise.all([
    fetchRemote<Project[]>(remote, '/api/projects'),
    fetchRemote<Session[]>(remote, '/api/sessions'),
    fetchRemote<Task[]>(remote, '/api/tasks'),
    fetchRemote<Epic[]>(remote, '/api/epics'),
  ]);
  return { machine: remote.name, projects, sessions, tasks, epics };
}

/** State of this machine and of the machines declared in remotes.json; unreachable ones are listed as such. */
async function collectState(db: CerebroDatabase): Promise<unknown> {
  const local: MachineData = {
    machine: MACHINE_NAME,
    projects: db.listProjects(),
    sessions: db.listSessions(),
    tasks: db.listTasks(),
    epics: db.listEpics(),
  };
  const remotes = await Promise.all(loadRemotes().map(async (remote) => {
    try {
      return { ok: true as const, data: await remoteData(remote) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[ask] machine ${remote.name} injoignable :`, reason);
      return { ok: false as const, machine: remote.name, error: reason };
    }
  }));
  return {
    now: date(Date.now()),
    machines: [
      snapshot(local),
      ...remotes.map((remote) => remote.ok ? snapshot(remote.data) : { machine: remote.machine, unreachable: remote.error }),
    ],
  };
}

function systemPrompt(state: unknown): string {
  return [
    "Tu es l'assistant de Cerebro, un outil qui pilote des sessions d'agents de code (Claude, Codex, Grok) par projet, avec un backlog de tâches par projet.",
    "L'utilisateur t'interroge depuis Slack. Réponds en français, de façon concise et directe, en Markdown simple (listes, gras, code) : pas de tableaux.",
    "Statuts de session : starting, running (l'agent travaille), waiting (attend une réponse ou une confirmation), idle (tour terminé), exited (terminée).",
    'Statuts de tâche : todo (à faire), started (confiée à une session), done (terminée).',
    "L'état ci-dessous (JSON) est l'état actuel, sur cette machine et sur les machines distantes joignables. Pour une question sur le code d'un projet, tu peux lire ses fichiers (Read, Glob, Grep) à partir de son chemin, uniquement pour un projet de cette machine.",
    "Tu ne peux rien modifier. Si la réponse n'est pas dans ces données, dis-le.",
    '',
    '<etat_cerebro>',
    JSON.stringify(state),
    '</etat_cerebro>',
  ].join('\n');
}

/** Answers a free-form question about Cerebro's projects, sessions and backlog. */
export async function answerQuestion(db: CerebroDatabase, question: string): Promise<string> {
  const state = await collectState(db);
  const { stdout } = await execFileAsync('which', ['claude']);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ANSWER_TIMEOUT_MS);
  try {
    const session = query({
      prompt: question,
      options: {
        cwd: homedir(),
        pathToClaudeCodeExecutable: stdout.trim(),
        persistSession: false,
        settingSources: ['user'],
        systemPrompt: systemPrompt(state),
        tools: TOOLS,
        allowedTools: TOOLS,
        permissionMode: 'dontAsk',
        additionalDirectories: db.listProjects().map((project) => project.path),
        maxTurns: MAX_TURNS,
        abortController: abort,
      },
    });
    for await (const message of session) {
      if (message.type !== 'result') continue;
      if (message.subtype === 'success' && !message.is_error) return message.result;
      throw new Error(message.subtype === 'success' ? message.result : `échec de la requête (${message.subtype})`);
    }
    throw new Error('aucune réponse de Claude');
  } catch (error) {
    if (abort.signal.aborted) throw new Error(`délai de ${ANSWER_TIMEOUT_MS / 60_000} min dépassé`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
