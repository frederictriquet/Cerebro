import { randomUUID } from 'node:crypto';
import type { Agent, Project, Session } from '../shared/types.ts';
import { answerQuestion } from './ask.ts';
import type { CouncilRuns } from './council-runner.ts';
import type { CerebroDatabase } from './db.ts';
import { answerFactQuestion, FACT_HELP } from './facts.ts';
import { normalizeProjectName, type PeerSync } from './peers.ts';
import type { SessionManager } from './sessions.ts';
import type { SlackClient, SlackMessage } from './slack-api.ts';
import {
  councilSlackText,
  decodeSlackText,
  escapeMrkdwn,
  INACTIVE_SESSION_REPLY,
  parseCouncilCommand,
  parseDmCommand,
  sessionHeader,
  sessionLink,
  slackMarkdown,
  splitMessage,
} from './slack-format.ts';
import { typeIntoSession } from './slack-polling.ts';
import { newThread, type SlackState } from './slack-state.ts';
import { errorMessage } from './util.ts';

// Le fil Slack reprend la session active la plus récemment touchée, pas la plus récemment créée.
function latestActive(sessions: Session[], agent: Agent | null = null): Session | undefined {
  return sessions
    .filter((session) => session.status !== 'exited' && (agent === null || session.agent === agent))
    .reduce<Session | undefined>(
      (best, session) => (best === undefined || session.updatedAt > best.updatedAt ? session : best),
      undefined,
    );
}

/** Types a DM command into an existing session, closing its question dialog first. */
export async function injectDmMessage(sessions: SessionManager, session: Session, text: string): Promise<boolean> {
  if (session.status === 'exited') return false;
  const questions = session.status === 'waiting' ? sessions.pendingQuestions(session.id) : null;
  return typeIntoSession(sessions, session.id, `[Message Slack] ${text}`, questions !== null);
}

export interface DmCommandHooks {
  /** Types a command into an existing session. */
  inject: (session: Session, text: string) => Promise<boolean>;
  /** Runs `council:` commands; null when councils are unavailable on this machine. */
  councils: () => CouncilRuns | null;
}

/**
 * Commands written in the DM: help, project list, `? question`, `council:` and `projet: instruction`. With several
 * machines sharing the DM, each command is handled by a single one.
 */
export class SlackDmCommands {
  private readonly client: SlackClient;
  private readonly state: SlackState;
  private readonly db: CerebroDatabase;
  private readonly sessions: SessionManager;
  private readonly peers: PeerSync;
  private readonly hooks: DmCommandHooks;

  constructor(
    client: SlackClient,
    state: SlackState,
    db: CerebroDatabase,
    sessions: SessionManager,
    peers: PeerSync,
    hooks: DmCommandHooks,
  ) {
    this.client = client;
    this.state = state;
    this.db = db;
    this.sessions = sessions;
    this.peers = peers;
    this.hooks = hooks;
  }

  async handle(channel: string, message: SlackMessage): Promise<void> {
    const text = decodeSlackText(message.text ?? '');
    const shortcut = text.toLocaleLowerCase('fr-FR');
    await this.peers.ready;
    // Machines sharing the DM: a single one handles commands that target no project.
    const general = this.peers.generalResponder();
    if (shortcut === 'help' || shortcut === 'aide' || shortcut === '?') {
      if (!general) return;
      await this.client.postThreadReply(channel, message.ts, this.helpText());
      return;
    }
    if (shortcut === 'list' || shortcut === 'liste' || shortcut === 'projets') {
      if (!general) return;
      await this.client.postThreadReply(channel, message.ts, this.projectListText());
      return;
    }
    const question = text.match(/^\?\s*([\s\S]+)$/)?.[1]?.trim();
    if (question !== undefined && question !== '') {
      // Answered with the state of the other machines it can reach.
      if (!general) return;
      // The answer can take minutes: thread polling must not wait for it.
      void this.answerQuestion(channel, message.ts, question);
      return;
    }
    const council = parseCouncilCommand(text);
    if (council !== null) {
      const project =
        council.projectName === null ? null : await this.dmProject(channel, message.ts, council.projectName, general);
      if (council.projectName === null ? !general : project === null) return;
      // Several minutes of headless calls: thread polling must not wait for them.
      void this.answerCouncil(channel, message.ts, project, council.question);
      return;
    }
    const command = parseDmCommand(text);
    if (command === null) {
      if (!general) return;
      await this.client.postThreadReply(channel, message.ts, this.helpText('Message non reconnu.'));
      return;
    }
    const project = await this.dmProject(channel, message.ts, command.projectName, general);
    if (project === null) return;
    let session = command.forceNew ? undefined : latestActive(this.db.listProjectSessions(project.id), command.agent);
    const created = session === undefined;
    const queued = session?.status === 'running';
    if (session === undefined) {
      try {
        session = await this.sessions.create(
          project,
          {
            ...(command.agent === null ? {} : { agent: command.agent }),
            prompt: command.text,
          },
          { rememberDefaults: false },
        );
      } catch (error) {
        await this.client.postThreadReply(
          channel,
          message.ts,
          `:x: Impossible de créer la session : ${escapeMrkdwn(errorMessage(error))}`,
        );
        return;
      }
    } else if (!(await this.hooks.inject(session, command.text))) {
      await this.client.postThreadReply(channel, message.ts, INACTIVE_SESSION_REPLY);
      return;
    }
    // Slack instructions belong to the session; preserve the web form's prompt.
    if (command.agent !== null) {
      this.sessions.rememberDefaults(project.id, { agent: command.agent });
    }
    await this.followSession(channel, message.ts, session, created, queued);
  }

  /** Acknowledges a command in its thread, which then relays the session's turn ends and reads its replies. */
  private async followSession(
    channel: string,
    threadTs: string,
    session: Session,
    created: boolean,
    queued: boolean,
  ): Promise<void> {
    const response = await this.client.call('chat.postMessage', {
      channel,
      thread_ts: threadTs,
      text: `:arrow_right: ${sessionHeader(this.db, session)} — ${created ? 'nouvelle session' : 'session existante'}\n${sessionLink(session.id)}`,
      unfurl_links: false,
    });
    if (typeof response.ts !== 'string') throw new Error('Réponse chat.postMessage sans timestamp');
    this.state.threads.set(
      session.id,
      newThread({
        channel,
        ts: threadTs,
        lastTs: response.ts,
        kind: 'notify',
        awaitingReply: true,
        skipTurnEnd: queued,
        fromDm: true,
      }),
    );
    this.state.markDirty();
    await this.client.acknowledge(channel, threadTs);
  }

  /** Project targeted by a DM command; null when this machine does not handle it (any error reply is posted). */
  private async dmProject(
    channel: string,
    threadTs: string,
    projectName: string,
    general: boolean,
  ): Promise<Project | null> {
    const projects = this.db.listProjects();
    const normalizedName = normalizeProjectName(projectName);
    const exact = projects.filter((project) => normalizeProjectName(project.name) === normalizedName);
    // An exact name on another machine beats a prefix match here; that machine handles it.
    if (exact.length === 0 && this.peers.knownRemotely(projectName, true)) return null;
    // Even when its machine is offline: never run a local prefix match instead.
    const offlineExact = exact.length === 0 ? this.peers.unreachableMachines(projectName, true) : [];
    const matches =
      exact.length > 0 || offlineExact.length > 0
        ? exact
        : projects.filter((project) => normalizeProjectName(project.name).startsWith(normalizedName));
    // Handled by the machine that has this project: no "unknown project" reply from this one.
    if (matches.length === 0 && offlineExact.length === 0 && this.peers.knownRemotely(projectName, false)) return null;
    if (matches.length === 0) {
      // Known only on machines that stopped syncing: nobody would handle it, a single machine says so.
      const offline = offlineExact.length > 0 ? offlineExact : this.peers.unreachableMachines(projectName, false);
      if (offline.length > 0) {
        if (general) {
          await this.client.postThreadReply(
            channel,
            threadTs,
            `:zzz: Projet « ${escapeMrkdwn(projectName)} » connu sur ${escapeMrkdwn(offline.join(', '))}, actuellement injoignable.`,
          );
        }
        return null;
      }
    }
    if (matches.length !== 1) {
      // Unknown everywhere: a single machine says so. An ambiguous prefix is only ambiguous here.
      if (matches.length === 0 && !general) return null;
      const error =
        matches.length === 0
          ? `Projet introuvable : « ${projectName} ».`
          : `Nom de projet ambigu : « ${projectName} ».`;
      await this.client.postThreadReply(channel, threadTs, this.helpText(error));
      return null;
    }
    const project = matches[0];
    if (project === undefined) return null;
    const conflicts = this.peers.conflictMachines(project);
    if (conflicts.length > 0) {
      // Same name, other repository: nothing runs until one project is renamed; a single machine says so.
      if (this.peers.conflictResponder(project)) {
        await this.client.postThreadReply(
          channel,
          threadTs,
          `:no_entry: « ${escapeMrkdwn(project.name)} » existe aussi sur ${escapeMrkdwn(conflicts.join(', '))} avec un autre dépôt git : commande bloquée. Renomme l'un des deux projets.`,
        );
      }
      return null;
    }
    // Another machine has the Slack lead on this shared project.
    return this.peers.owns(project.name) ? project : null;
  }

  /** `council: question`: headless council run, its synthesis posted in the request thread. */
  private async answerCouncil(
    channel: string,
    threadTs: string,
    project: Project | null,
    question: string,
  ): Promise<void> {
    await this.answerSlowly(channel, threadTs, 'Council impossible', async () => {
      const councils = this.hooks.councils();
      if (councils === null) throw new Error('council indisponible sur cette machine.');
      // readProject absent : valeur des réglages effectifs du projet.
      const run = await councils.start({ projectId: project?.id ?? null, origin: 'slack', question }, randomUUID());
      return councilSlackText((await councils.finished(run.id)) ?? run, project?.name ?? null);
    });
  }

  /** `? question`: free-form question answered by Claude from Cerebro's state. */
  async answerQuestion(channel: string, threadTs: string, question: string): Promise<void> {
    await this.answerSlowly(channel, threadTs, 'Impossible de répondre', async () => {
      const factual = await answerFactQuestion(this.db, question);
      return slackMarkdown(factual ?? (await answerQuestion(this.db, question)));
    });
  }

  /** Posts in the thread the text `answer` produces, or its failure, with an hourglass on the request meanwhile. */
  private async answerSlowly(
    channel: string,
    threadTs: string,
    failure: string,
    answer: () => Promise<string>,
  ): Promise<void> {
    await this.client
      .call('reactions.add', { channel, timestamp: threadTs, name: 'hourglass_flowing_sand' })
      .catch((error: unknown) => this.client.logError(error));
    let text: string;
    try {
      text = await answer();
    } catch (error) {
      this.client.logError(error);
      text = `:x: ${failure} : ${escapeMrkdwn(errorMessage(error))}`;
    }
    try {
      for (const chunk of splitMessage(text)) await this.client.postThreadReply(channel, threadTs, chunk);
    } catch (error) {
      this.client.logError(error);
    }
    await this.client
      .call('reactions.remove', { channel, timestamp: threadTs, name: 'hourglass_flowing_sand' })
      .catch((error: unknown) => this.client.logError(error));
  }

  private projectLines(): string[] {
    const lines = this.db.listProjects().map((project) => {
      const active = latestActive(this.db.listProjectSessions(project.id));
      const detail =
        active === undefined
          ? '_aucune session active_'
          : `${escapeMrkdwn(active.title)} (${active.agent}, statut : ${active.status})`;
      return `• *${escapeMrkdwn(project.name)}* — ${detail}`;
    });
    // A single machine answers `list`: projects only present on the other active machines are shown too.
    const local = new Set(this.db.listProjects().map((project) => normalizeProjectName(project.name)));
    for (const remote of this.peers.activePeerProjects()) {
      if (local.has(normalizeProjectName(remote.name))) continue;
      local.add(normalizeProjectName(remote.name));
      lines.push(`• *${escapeMrkdwn(remote.name)}* — _sur ${escapeMrkdwn(remote.machine)}_`);
    }
    return lines.length > 0 ? lines : ['_Aucun projet configuré._'];
  }

  private projectListText(): string {
    return ['*Projets connus*', ...this.projectLines()].join('\n');
  }

  private helpText(error?: string): string {
    return [
      ...(error === undefined ? [] : [`:warning: ${escapeMrkdwn(error)}`, '']),
      '*Piloter Cerebro depuis Slack*',
      '`projet: instruction` — reprendre la session active, ou en créer une',
      '`projet+: instruction` — toujours créer une nouvelle session',
      '`projet/agent: instruction` — choisir `claude`, `codex` ou `grok`',
      '`projet/agent+: instruction` — choisir l’agent et créer une nouvelle session',
      '`council: question` — réunir le council de LLM hors projet (synthèse dans le fil)',
      '`projet/council: question` — réunir le council sur un projet, avec ses réglages (lecture du dépôt comprise)',
      '`list` — lister les projets et leur session active',
      '`? question` — poser une question sur les projets, sessions et backlogs (ex. `? où en sont les tâches du projet ACME ?`)',
      '',
      FACT_HELP,
      '*Projets connus*',
      ...this.projectLines(),
      '',
      '*Répondre dans un fil de session*',
      'Le texte libre est injecté dans la session. `entrée`/`enter` envoie Entrée ; `échap`/`esc` envoie Échap.',
      'Pendant une confirmation, réponds avec un chiffre, `y` ou `n`. Pour les questions à options : `1`, `1 3` ou `1,3`.',
      '',
      '_Les nouvelles sessions reprennent les réglages du projet (agent, modèle, effort et mode). L’instruction du message sert de prompt._',
    ].join('\n');
  }
}
