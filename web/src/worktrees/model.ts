import type { Session } from '../../../shared/types.ts';
import type { StartingContentStep, StartingOrigin, WorktreeView } from '../../../shared/worktrees.ts';
import { formatDateTime, plural, pluralize, sessionTitle } from '../format.ts';

export const branchName = (branch: string | null): string =>
  branch?.replace(/^refs\/heads\//, '') ?? 'branche inconnue';
export const createdLabel = (view: WorktreeView): string => formatDateTime(view.createdAt);
export const copyTitle = (view: WorktreeView): string =>
  sessionTitle(view.session?.title ?? view.sessionTitle ?? `Conversation supprimée · ${createdLabel(view)}`);
export function originLabel(origin: StartingOrigin | null, target: string): string {
  if (!origin) return 'ce contenu n’existe plus que dans cette copie';
  if (origin.kind === 'target-commit') return `déjà dans ${target} · ${origin.commit.slice(0, 7)} ${origin.subject}`;
  if (origin.kind === 'target-worktree') return `toujours présent, non commité, dans le dossier de ${target}`;
  return 'conservé par Cerebro à la création de la copie';
}

export type MergeStepState = 'done' | 'todo' | 'blocked' | 'waiting';
/** The path of a copy towards the project: save its work, settle conflicts with the target, integrate, publish. */
export interface Journey {
  status: string;
  /** One sentence telling what to do next. */
  next: string | null;
  inherited: StartingContentStep['path'][];
  mixed: { path: string; origin: StartingOrigin | null; separable: boolean }[];
  /** Files edited since the copy whose starting content is gone: only the removal action settles them. */
  settled: { path: string; origin: StartingOrigin | null }[];
  ownWork: number;
  save: MergeStepState;
  update: MergeStepState;
  integrate: MergeStepState;
}
export function journey(view: WorktreeView): Journey {
  const changes = view.changesSinceCreation;
  const starting = view.startingContent ?? [];
  const inherited = starting.filter((file) => file.state === 'inherited').map((file) => file.path);
  const mixed = starting.filter((file) => file.state === 'mixed');
  const settled = starting.filter((file) => file.state === 'settled');
  const ownWork = changes ? changes.count - changes.needsReviewCount : 0;
  const target = branchName(view.targetBranch);
  const dirty = !!view.dirty;
  const conflicts = view.integrationConflicts;
  const otherBlockers = view.mergeBlockers.filter((reason) => !reason.startsWith('La copie contient'));
  const save: MergeStepState = view.mergeInProgress ? 'waiting' : dirty ? 'todo' : 'done';
  const update: MergeStepState = view.mergeInProgress
    ? 'todo'
    : !view.ahead || !view.behind || conflicts?.length === 0
      ? 'done'
      : conflicts === null
        ? 'waiting'
        : dirty
          ? 'blocked'
          : 'todo';
  const integrate: MergeStepState =
    view.integration === 'integrated'
      ? 'done'
      : !view.ahead
        ? 'waiting'
        : view.mergeBlockers.length
          ? 'blocked'
          : 'todo';
  let status: string;
  let next: string | null;
  if (view.error) {
    status = 'État indisponible';
    next = null;
  } else if (view.mergeInProgress) {
    status = 'Conflits à résoudre';
    const resolver = view.resolver;
    const marked = view.remainingMarkers.length;
    next =
      resolver && resolver.status !== 'idle' && resolver.status !== 'exited'
        ? `La session « ${sessionTitle(resolver.title)} » résout les conflits : attendez la fin de son tour, relisez ses changements, puis terminez la mise à jour.`
        : resolver && !marked
          ? `La session « ${sessionTitle(resolver.title)} » a retiré tous les marqueurs : relisez ses changements, puis terminez la mise à jour.`
          : resolver
            ? `Il reste des marqueurs dans ${plural(marked, 'fichier')} : aidez la session « ${sessionTitle(resolver.title)} » ou terminez-les vous-même, puis terminez la mise à jour.`
            : view.conflicts.length
              ? `Résolvez les conflits dans la copie (${plural(view.conflicts.length, 'fichier')}), vous-même ou avec « Résoudre avec l’IA », puis terminez la mise à jour.`
              : 'Les conflits sont résolus : terminez la mise à jour.';
  } else if (dirty && !view.ahead && !changes?.count) {
    status = 'Copie de départ';
    next = 'Aucun travail de la conversation : la copie ne contient que le contenu copié du projet.';
  } else if (dirty && (inherited.length || mixed.some((file) => file.separable))) {
    status = 'Contenu de départ à retirer';
    next = `Retirez le contenu copié du projet à la création (${plural(inherited.length + mixed.filter((file) => file.separable).length + settled.length, 'fichier')}), pour ne garder que le travail de la conversation.`;
  } else if (dirty && settled.length) {
    status = 'Contenu de départ à retirer';
    next = `Le contenu de départ a déjà disparu de ${plural(settled.length, 'fichier')} : « Retirer le contenu de départ » ${settled.length === 1 ? 'le rattache' : 'les rattache'} au travail de la conversation, sans ${settled.length === 1 ? 'le' : 'les'} modifier.`;
  } else if (dirty && ownWork) {
    status = 'Travail à enregistrer';
    next = mixed.length
      ? `Créez le commit du travail de la conversation, puis commitez ${pluralize(mixed.length, 'tel quel', 'tels quels')} ${plural(mixed.length, 'fichier')} après lecture de ${mixed.length === 1 ? 'son' : 'leur'} diff.`
      : 'Créez le commit du travail de la conversation.';
  } else if (dirty && mixed.length) {
    status = 'Fichiers à commiter tels quels';
    next = `Lisez le diff de ${plural(mixed.length, 'fichier')} qui mêlent contenu de départ et travail récent, puis commitez-${mixed.length === 1 ? 'le tel quel' : 'les tels quels'}.`;
  } else if (dirty) {
    status = 'Changements à examiner';
    next = `Examinez ${plural(view.dirty!, 'fichier')} : leur origine ne peut pas être vérifiée automatiquement.`;
  } else if (view.ahead && conflicts?.length) {
    status = 'Conflits prévus';
    next = `Mettez la copie à jour avec ${target} pour résoudre ${conflicts.length === 1 ? 'le conflit' : 'les conflits'} dans la copie.`;
  } else if (view.ahead && otherBlockers.length) {
    status = 'Intégration bloquée';
    next = otherBlockers[0];
  } else if (view.ahead) {
    status = 'Prêt à intégrer';
    next = `Intégrez ${view.ahead === 1 ? 'le commit' : `les ${view.ahead} commits`} dans ${target}.`;
  } else if (view.integration === 'integrated' && view.published) {
    status = 'Publié';
    next = `Le travail est dans ${target} et sur le dépôt distant.`;
  } else if (view.integration === 'integrated') {
    status = 'Intégré au projet';
    next = `Le travail est dans ${target} sur cette machine. Utilisez « Push » dans l’en-tête du projet pour le publier.`;
  } else {
    status = 'État à vérifier';
    next = null;
  }
  return {
    status,
    next,
    inherited,
    mixed: mixed.map(({ path, origin, separable }) => ({ path, origin, separable })),
    settled: settled.map(({ path, origin }) => ({ path, origin })),
    ownWork,
    save,
    update,
    integrate,
  };
}

// Files of the starting content grouped by what the removal action can do with them.
export function startingContentGroups(plan: Journey): {
  separable: Journey['mixed'];
  manual: Journey['mixed'];
  removable: boolean;
} {
  const separable = plan.mixed.filter((file) => file.separable);
  const manual = plan.mixed.filter((file) => !file.separable);
  return { separable, manual, removable: plan.inherited.length > 0 || separable.length > 0 || plan.settled.length > 0 };
}

/** What blocks the removal of a copy besides its ignored files, which the removal dialog deletes on confirmation. */
export function removalBlockers(view: WorktreeView): string[] {
  // The server lists the ignored files last (ignoredReason in server/worktrees.ts).
  return !view.error && view.ignored ? view.removeBlockers.slice(0, -1) : view.removeBlockers;
}
/** A copy whose work is all in its target: nothing left to do but remove it. */
export const finished = (view: WorktreeView): boolean =>
  !view.error && !view.dirty && !view.mergeInProgress && view.ahead === 0 && view.integration === 'integrated';

// No machine stamp: switching machines remounts the whole tree (StoreProvider keyed by machine in App).
export interface Confirmation {
  kind: 'merge' | 'remove';
  token: string;
  view: WorktreeView;
  /** The removal also deletes the ignored files listed in `view`. */
  deleteIgnored: boolean;
}

export interface Reviewed {
  snapshotId: string;
  paths: string[];
  /** Blocked files declared false positives of the secret scanner, in the same snapshot. */
  secrets: string[];
}

export type Resolver = Pick<Session, 'id' | 'title'>;

/** What a copy row asks of the panel that owns the dialogs, the busy state and the refresh. */
export interface WorktreeActions {
  /** `deleteIgnored`: the removal also deletes the ignored files to keep, listed in the confirmation. */
  prepare: (view: WorktreeView, kind: 'merge' | 'remove', deleteIgnored?: boolean) => Promise<void>;
  act: (view: WorktreeView, action: string) => Promise<void>;
  chooseTarget: (view: WorktreeView, branch: string) => Promise<void>;
  discard: (view: WorktreeView) => void;
  commit: (view: WorktreeView, reviewed?: Reviewed) => void;
  open: (id: string) => void;
  toggle: (id: string) => void;
  /** A session was launched to resolve the conflicts of `view`: the inventory exposes it as `view.resolver`. */
  resolving: (view: WorktreeView) => void;
}
