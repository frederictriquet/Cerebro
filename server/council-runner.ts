import { statSync, unlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { getAgentAvailability } from './agents.ts';
import { ATTACHMENTS_DIR } from './config.ts';
import {
  ANSWER_SCHEMA,
  MIN_ADVISORS,
  REVIEW_SCHEMA,
  SYNTHESIS_SCHEMA,
  answerPrompt,
  assignLetters,
  defaultCouncilSettings,
  imagePaths,
  imageToken,
  parseAnswer,
  parseCouncilImages,
  parseReview,
  parseSynthesis,
  readsProject,
  resolveParticipants,
  reviewLetters,
  reviewPrompt,
  synthesisPrompt,
  type Advisor,
  type CouncilImage,
  type CouncilPhase,
  type CouncilRun,
  type CouncilSettings,
} from './council.ts';
import type { Agent, CerebroDatabase, Project } from './db.ts';
import { imageMediaType, runHeadless, supportsImages, type HeadlessOptions } from './headless.ts';

export const ANSWER_TIMEOUT_MS = 10 * 60_000;
export const REVIEW_TIMEOUT_MS = 5 * 60_000;
export const SYNTHESIS_TIMEOUT_MS = 10 * 60_000;
export const MAX_QUESTION_LENGTH = 10_000;
export const MAX_CONTEXT_LENGTH = 100_000;

export interface CouncilStart {
  projectId: string | null;
  origin: 'web' | 'slack';
  question: string;
  context?: string;
  // Ignoré hors projet ; absent : valeur par défaut des réglages effectifs.
  readProject?: boolean;
  // Absent : participants par défaut des réglages effectifs.
  participants?: unknown;
  // Images jointes `[{n, path}]`, enregistrées au préalable sous le dossier des pièces jointes.
  images?: unknown;
}

// Erreur de lancement ou d'annulation, avec le code HTTP à renvoyer.
export class CouncilError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

// Un chemin d'image accepté est un fichier image existant sous le dossier des pièces jointes du serveur.
function attachedImage(path: string): string | null {
  const absolute = resolve(path);
  if (!absolute.startsWith(resolve(ATTACHMENTS_DIR) + sep)) return 'hors du dossier des pièces jointes';
  if (imageMediaType(absolute) === null) return 'format non pris en charge';
  try {
    if (!statSync(absolute).isFile()) return 'fichier introuvable';
  } catch {
    return 'fichier introuvable';
  }
  return null;
}

// Vérifie forme, emplacement et existence des images, puis la compatibilité de chaque agent sollicité.
export function checkImages(raw: unknown, llms: readonly { agent: Agent; label: string }[]): CouncilImage[] {
  const parsed = parseCouncilImages(raw);
  if ('error' in parsed) throw new CouncilError(parsed.error);
  for (const image of parsed.images) {
    const problem = attachedImage(image.path);
    if (problem !== null) throw new CouncilError(`${imageToken(image.n)} : ${problem}.`);
  }
  if (parsed.images.length > 0) {
    const unable = llms.filter((llm) => !supportsImages(llm.agent));
    if (unable.length > 0)
      throw new CouncilError(
        `Images jointes : ${unable.map((llm) => `${llm.label} (${llm.agent})`).join(', ')} ne ${unable.length > 1 ? 'prennent' : 'prend'} pas en charge les images. Choisissez claude ou codex.`,
      );
  }
  return parsed.images;
}

export class CouncilRuns {
  private db: CerebroDatabase;
  private active = new Map<string, { run: CouncilRun; abort: AbortController; done: Promise<void> }>();
  private deletingProjects = new Set<string>();
  private closed = false;
  onComplete: (run: CouncilRun) => void = () => {};

  constructor(db: CerebroDatabase) {
    this.db = db;
    for (const run of this.list())
      if (run.status === 'running') {
        const now = Date.now();
        for (const step of [...run.answers, ...run.reviews])
          if (step.finishedAt === null) {
            step.error ??= 'Interrompu par le redémarrage du serveur.';
            step.finishedAt = now;
          }
        run.status = 'interrupted';
        run.phase = 'finished';
        run.finishedAt = now;
        run.error = 'Serveur redémarré pendant le council : les avis obtenus sont conservés, relancez-le si besoin.';
        this.save(run);
      }
  }

  // undefined : tous les runs ; null : ceux lancés hors projet.
  list(projectId?: string | null): CouncilRun[] {
    return this.db.listCouncilRuns(projectId);
  }

  get(id: string): CouncilRun | null {
    return this.db.getCouncilRun(id);
  }

  // Lanceur headless ; remplacé dans les tests.
  async invoke(options: HeadlessOptions): Promise<unknown> {
    return runHeadless(options);
  }

  async availableAgents(): Promise<Agent[]> {
    return (await getAgentAvailability()).filter((entry) => entry.available).map((entry) => entry.agent);
  }

  // Réglages effectifs : surcharge du projet, sinon réglages globaux, sinon défauts calculés.
  async settingsFor(project: Project | null): Promise<CouncilSettings> {
    return (
      project?.councilSettings ??
      this.db.getSetting<CouncilSettings>('council') ??
      defaultCouncilSettings(this.db.listPersonas(), await this.availableAgents())
    );
  }

  private save(run: CouncilRun): boolean {
    return this.db.saveCouncilRun(run);
  }

  private projectForStart(id: string | null): Project | null {
    if (id === null) return null;
    if (this.deletingProjects.has(id)) throw new CouncilError('Suppression du projet en cours.', 409);
    const project = this.db.getProject(id);
    if (project === null) throw new CouncilError('Projet introuvable.', 404);
    return project;
  }

  // Le verrou couvre aussi l'arrêt des sessions et l'effacement des données du projet.
  async withProjectDeletion(projectId: string, remove: () => Promise<void>): Promise<void> {
    if (this.deletingProjects.has(projectId)) throw new CouncilError('Suppression du projet déjà en cours.', 409);
    this.deletingProjects.add(projectId);
    try {
      const active = [...this.active.values()].filter((item) => item.run.projectId === projectId);
      for (const item of active) item.abort.abort();
      await Promise.allSettled(active.map((item) => item.done));
      await remove();
    } finally {
      this.deletingProjects.delete(projectId);
    }
  }

  // Idempotent sur `requestId`, qui devient l'identifiant du run.
  async start(input: CouncilStart, requestId: unknown): Promise<CouncilRun> {
    if (this.closed) throw new CouncilError('Serveur en cours d’arrêt.', 409);
    if (typeof requestId !== 'string' || !/^[\da-f-]{36}$/i.test(requestId))
      throw new CouncilError('Identifiant de lancement invalide.');
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    const context = typeof input.context === 'string' ? input.context.trim() : input.context === undefined ? '' : null;
    if (question === '' || question.length > MAX_QUESTION_LENGTH)
      throw new CouncilError(`Question requise (1 à ${MAX_QUESTION_LENGTH} caractères).`);
    if (context === null || context.length > MAX_CONTEXT_LENGTH)
      throw new CouncilError(`Contexte invalide (${MAX_CONTEXT_LENGTH} caractères au plus).`);
    if (input.readProject !== undefined && typeof input.readProject !== 'boolean')
      throw new CouncilError('Option de lecture du projet invalide.');
    const previous = this.reuse(requestId, input.projectId, question);
    if (previous !== null) return previous;
    let project = this.projectForStart(input.projectId);
    const settings = structuredClone(await this.settingsFor(project));
    const resolved = resolveParticipants(settings, this.db.listPersonas(), input.participants);
    if ('error' in resolved) throw new CouncilError(resolved.error);
    // Relectures et synthèse reçoivent aussi les images : le chairman doit les accepter comme les conseillers.
    const images = checkImages(input.images, [
      ...resolved.advisors.map((advisor) => ({ agent: advisor.agent, label: advisor.name })),
      { agent: settings.chairman.agent, label: 'chairman' },
    ]);
    if (this.closed) throw new CouncilError('Serveur en cours d’arrêt.', 409);
    // La suppression a pu commencer ou se terminer pendant la résolution des réglages.
    project = this.projectForStart(input.projectId);
    // Un lancement identique a pu aboutir pendant la lecture des agents disponibles.
    const raced = this.reuse(requestId, input.projectId, question);
    if (raced !== null) return raced;
    const now = Date.now();
    const advisors = resolved.advisors;
    const run: CouncilRun = {
      id: requestId,
      projectId: input.projectId,
      origin: input.origin,
      question,
      context,
      images,
      readProject: project !== null && (input.readProject ?? settings.readProject),
      settings,
      advisors,
      status: 'running',
      phase: 'answering',
      letters: assignLetters(advisors),
      answers: advisors.map((advisor) => ({
        advisorId: advisor.personaId,
        text: null,
        error: null,
        startedAt: now,
        finishedAt: null,
      })),
      reviews: [],
      synthesis: null,
      error: null,
      startedAt: now,
      finishedAt: null,
    };
    if (!this.save(run)) throw new CouncilError('Projet introuvable.', 404);
    const abort = new AbortController();
    const done = Promise.resolve()
      .then(() => this.execute(run, project, abort.signal))
      .finally(() => this.active.delete(run.id));
    this.active.set(run.id, { run, abort, done });
    return run;
  }

  // Run déjà créé sous cet identifiant, refusé s'il porte sur une autre question ou un autre projet.
  private reuse(requestId: string, projectId: string | null, question: string): CouncilRun | null {
    const existing = this.get(requestId);
    if (existing !== null && (existing.projectId !== projectId || existing.question !== question))
      throw new CouncilError('Ce lancement correspond à un autre council.', 409);
    return existing;
  }

  cancel(id: string): CouncilRun {
    const active = this.active.get(id);
    if (active === undefined) {
      if (this.get(id) === null) throw new CouncilError('Council introuvable.', 404);
      throw new CouncilError('Ce council est déjà terminé.', 409);
    }
    active.abort.abort();
    return active.run;
  }

  // Les images jointes appartiennent au run : elles disparaissent avec lui.
  delete(id: string): void {
    if (this.active.has(id)) throw new CouncilError('Ce council est en cours : annulez-le avant de le supprimer.', 409);
    const run = this.get(id);
    if (run === null || !this.db.deleteCouncilRun(id)) throw new CouncilError('Council introuvable.', 404);
    for (const path of imagePaths(run)) {
      if (attachedImage(path) !== null) continue;
      try {
        unlinkSync(path);
      } catch (cause) {
        console.warn(`Image du council ${id} non supprimée (${path}) :`, message(cause));
      }
    }
  }

  // Run tel qu'enregistré à la fin de son exécution (immédiatement s'il n'est plus en cours).
  async finished(id: string): Promise<CouncilRun | null> {
    await this.active.get(id)?.done;
    return this.get(id);
  }

  private async execute(run: CouncilRun, project: Project | null, signal: AbortSignal): Promise<void> {
    const phase = (value: CouncilPhase): void => {
      signal.throwIfAborted();
      run.phase = value;
      this.save(run);
    };
    // Seuls les conseillers lisent le dépôt ; relectures et synthèse portent sur les réponses.
    const reading = readsProject(run);
    const cwd = reading ? project?.path : undefined;
    const images = imagePaths(run);
    const call = (
      advisor: Advisor | CouncilSettings['chairman'],
      prompt: string,
      schema: object,
      timeoutMs: number,
      access: HeadlessOptions['access'] = 'none',
    ): Promise<unknown> =>
      this.invoke({
        agent: advisor.agent,
        model: advisor.model,
        effort: advisor.effort,
        prompt,
        schema,
        ...(access === 'none' ? {} : { cwd }),
        access,
        timeoutMs,
        signal,
        ...(images.length === 0 ? {} : { images }),
      });
    try {
      signal.throwIfAborted();
      if (reading && cwd === undefined) throw new Error('Projet introuvable.');
      await Promise.allSettled(
        run.advisors.map(async (advisor) => {
          const answer = run.answers.find((entry) => entry.advisorId === advisor.personaId)!;
          try {
            answer.text = parseAnswer(
              await call(
                advisor,
                answerPrompt(run, advisor, cwd ?? null),
                ANSWER_SCHEMA,
                ANSWER_TIMEOUT_MS,
                reading ? 'read-only' : 'none',
              ),
            );
          } catch (cause) {
            answer.error = message(cause);
          } finally {
            answer.finishedAt = Date.now();
            this.save(run);
          }
        }),
      );
      signal.throwIfAborted();
      const answered = run.advisors.filter((advisor) =>
        run.answers.some((answer) => answer.advisorId === advisor.personaId && answer.text !== null),
      );
      if (answered.length < MIN_ADVISORS)
        throw new Error(
          `${answered.length} réponse${answered.length > 1 ? 's' : ''} obtenue${answered.length > 1 ? 's' : ''} : il en faut au moins ${MIN_ADVISORS} pour la relecture croisée.`,
        );
      const startedAt = Date.now();
      run.reviews = answered.map((advisor) => ({
        advisorId: advisor.personaId,
        ranking: [],
        blindSpot: null,
        missed: null,
        error: null,
        startedAt,
        finishedAt: null,
      }));
      phase('reviewing');
      await Promise.allSettled(
        answered.map(async (advisor) => {
          const review = run.reviews.find((entry) => entry.advisorId === advisor.personaId)!;
          try {
            Object.assign(
              review,
              parseReview(
                await call(advisor, reviewPrompt(run, advisor), REVIEW_SCHEMA, REVIEW_TIMEOUT_MS),
                reviewLetters(run, advisor),
              ),
            );
          } catch (cause) {
            review.error = message(cause);
          } finally {
            review.finishedAt = Date.now();
            this.save(run);
          }
        }),
      );
      phase('synthesizing');
      const synthesis = parseSynthesis(
        await call(run.settings.chairman, synthesisPrompt(run), SYNTHESIS_SCHEMA, SYNTHESIS_TIMEOUT_MS),
      );
      signal.throwIfAborted();
      run.synthesis = synthesis;
      run.status = 'succeeded';
    } catch (cause) {
      run.status = signal.aborted ? (this.closed ? 'interrupted' : 'cancelled') : 'failed';
      run.error = signal.aborted
        ? this.closed
          ? 'Serveur arrêté pendant le council : les avis obtenus sont conservés.'
          : 'Council annulé.'
        : run.phase === 'synthesizing'
          ? `Synthèse impossible : ${message(cause)}`
          : message(cause);
    } finally {
      run.phase = 'finished';
      run.finishedAt = Date.now();
      if (this.save(run)) this.onComplete(run);
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const item of this.active.values()) item.abort.abort();
    await Promise.allSettled([...this.active.values()].map((item) => item.done));
  }
}
