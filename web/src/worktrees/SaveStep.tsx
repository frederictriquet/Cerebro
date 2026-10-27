import type { StartingContentDiscard, WorktreeView } from '../../../shared/worktrees.ts';
import { href } from '../route.ts';
import { plural, pluralize, sessionTitle } from '../format.ts';
import {
  branchName,
  originLabel,
  startingContentGroups,
  type Journey,
  type Resolver,
  type WorktreeActions,
} from './model.ts';
import { Step } from './Step.tsx';
import { WorktreeDiffs } from './WorktreeDiffs.tsx';

/** Step 1: commit the conversation's work in the copy, once the starting content is removed or reviewed. */
export function SaveStep({
  view,
  plan,
  target,
  result,
  resolver,
  commitBlocked,
  showDetails,
  actions,
}: {
  view: WorktreeView;
  plan: Journey;
  target: string;
  result: StartingContentDiscard | undefined;
  resolver: Resolver | undefined;
  commitBlocked: boolean;
  showDetails: boolean;
  actions: WorktreeActions;
}) {
  const changes = view.changesSinceCreation;
  const { separable, manual, removable } = startingContentGroups(plan);
  const startDiscard = (): void => actions.discard(view);
  return (
    <Step number={1} title="Enregistrer le travail dans la copie" state={plan.save}>
      {view.mergeInProgress ? (
        <p>
          Une mise à jour avec {target} est en cours : terminez-la ou annulez-la à l’étape 2 avant d’enregistrer
          d’autres changements.
        </p>
      ) : !view.dirty ? (
        <p>Aucun changement non commité : tout le travail de la copie est dans ses commits.</p>
      ) : null}
      {result && view.dirty ? (
        <p className="worktree-notice" role="status">
          {result.targetUpdate ? `Copie mise à jour avec ${branchName(result.targetUpdate.branch)}. ` : ''}
          {result.restored.length ? `${plural(result.restored.length, 'fichier')} remis à l’état de la copie. ` : ''}
          {result.separated.length
            ? `${plural(result.separated.length, 'fichier')} ${result.separated.length === 1 ? 'ne contient' : 'ne contiennent'} plus que le travail fait depuis la création. `
            : ''}
          {result.settled?.length
            ? `${plural(result.settled.length, 'fichier rattaché', 'fichiers rattachés')} au travail de la conversation. `
            : ''}
          {result.kept.length
            ? `${pluralize(result.kept.length, 'Non séparé')} : ${result.kept.map((step) => step.path).join(', ')}, à commiter ${pluralize(result.kept.length, 'tel quel', 'tels quels')} ci-dessous.`
            : ''}
        </p>
      ) : null}
      {resolver ? (
        <p className="worktree-notice" role="status">
          Session de résolution lancée dans la copie :{' '}
          <a href={href(`#/s/${resolver.id}`)}>{sessionTitle(resolver.title)}</a>. Une fois son tour terminé, relisez
          ses changements dans les diffs, puis retirez le contenu de départ restant.
        </p>
      ) : null}
      {!view.mergeInProgress && plan.inherited.length ? (
        <div className="worktree-group">
          <p>
            <strong>{plural(plan.inherited.length, 'fichier')} sans nouveau travail.</strong>{' '}
            {plan.inherited.length === 1 ? 'Ce fichier a' : 'Ces fichiers ont'} encore le contenu copié du dossier du
            projet à la création de la copie : ce n’est pas le travail de la conversation.
          </p>
          <ul className="worktree-files">
            {(view.startingContent ?? [])
              .filter((file) => file.state === 'inherited')
              .map((file) => (
                <li key={file.path}>
                  <code>{file.path}</code>{' '}
                  <span className={file.origin ? 'meta' : 'worktree-warning'}>
                    — {originLabel(file.origin, target)}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ) : null}
      {!view.mergeInProgress && separable.length ? (
        <div className="worktree-group">
          <p>
            <strong>
              {plural(separable.length, 'fichier')} mêlant contenu de départ et travail récent,{' '}
              {pluralize(separable.length, 'séparable')}.
            </strong>{' '}
            Le contenu de départ peut en être retiré automatiquement, en gardant le travail fait dans la copie.
          </p>
          <ul className="worktree-files">
            {separable.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>{' '}
                <span className="meta">— contenu de départ {originLabel(file.origin, target)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!view.mergeInProgress && plan.settled.length ? (
        <div className="worktree-group">
          <p>
            <strong>{plural(plan.settled.length, 'fichier')} sans contenu de départ restant.</strong>{' '}
            {plan.settled.length === 1
              ? 'Ses changements non commités ne contiennent'
              : 'Leurs changements non commités ne contiennent'}{' '}
            plus que du travail récent : le contenu de départ en a été retiré, par la conversation ou par une session de
            résolution.
          </p>
          <ul className="worktree-files">
            {plan.settled.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>{' '}
                <span className="meta">— contenu de départ {originLabel(file.origin, target)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!view.mergeInProgress && removable && view.dirty ? (
        <button type="button" className="btn primary" disabled={commitBlocked} onClick={startDiscard}>
          Retirer le contenu de départ…
        </button>
      ) : null}
      {!view.mergeInProgress && plan.ownWork && view.dirty ? (
        <div className="worktree-group">
          <p>
            <strong>{plural(plan.ownWork, 'fichier modifié', 'fichiers modifiés')} par la conversation.</strong> Le
            commit automatique ne prend que les fichiers dont l’origine est vérifiable.
          </p>
          <button type="button" className="btn" disabled={commitBlocked} onClick={() => actions.commit(view)}>
            Créer le commit
          </button>
        </div>
      ) : null}
      {!view.mergeInProgress && view.dirty && (manual.length || !changes) ? (
        <div className="worktree-group">
          {manual.length ? (
            <>
              <p>
                <strong>
                  {plural(manual.length, 'fichier')} à commiter {pluralize(manual.length, 'tel quel', 'tels quels')}.
                </strong>{' '}
                {manual.length === 1 ? 'Il mêle' : 'Ils mêlent'} contenu de départ et travail récent, sans séparation
                automatique possible :
              </p>
              <ul className="worktree-files">
                {manual.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>{' '}
                    <span className="worktree-warning">
                      —{' '}
                      {file.origin
                        ? `contenu de départ ${originLabel(file.origin, target)}, mais le travail récent touche les mêmes lignes ou a déjà été commité`
                        : 'contenu de départ introuvable'}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="meta">
                Pour terminer cette étape,{' '}
                {manual.length === 1
                  ? 'lisez son diff puis cochez-le : le commit emportera aussi son'
                  : 'lisez leur diff puis cochez-les : le commit emportera aussi leur'}{' '}
                contenu de départ. S’il diffère de {target}, l’écart apparaîtra comme conflit à l’étape 2 et se résoudra
                dans la copie. Pour ne garder que le travail de la conversation, confiez plutôt{' '}
                {manual.length === 1 ? 'ce fichier' : 'ces fichiers'} à l’IA : une session sépare le contenu de départ
                dans la copie, sans rien commiter. Une fois ce tri fait, validez{' '}
                {manual.length === 1 ? 'le fichier' : 'les fichiers'} dans la même fenêtre après lecture de{' '}
                {manual.length === 1 ? 'son' : 'leur'} diff :{' '}
                {manual.length === 1 ? 'il est rattaché' : 'ils sont rattachés'} au travail de la conversation.
              </p>
              <button type="button" className="btn" disabled={commitBlocked} onClick={startDiscard}>
                Résoudre avec l’IA ou valider…
              </button>
            </>
          ) : (
            <p className="meta">
              L’origine de ces changements ne peut pas être vérifiée : lisez leur diff puis cochez ceux à commiter.
            </p>
          )}
          {showDetails ? (
            <WorktreeDiffs
              view={view}
              onCommitReviewed={commitBlocked ? undefined : (value) => actions.commit(view, value)}
            />
          ) : null}
        </div>
      ) : null}
    </Step>
  );
}
