import { useCallback, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ChoiceGroup } from './ChoiceGroup.tsx';
import { LaunchSessionDialog, Modal } from './Dialog.tsx';
import { NewSessionForm } from './NewSessionForm.tsx';
import { useStore } from './store.tsx';
import type { Agent, GitInfo, LaunchSpec } from './types.ts';
import { isSubmitShortcut, SUBMIT_HINT } from './keys.ts';

type CommitStrategy = 'atomic' | 'single';

// Prompts génériques : ils doivent fonctionner avec Claude, Codex et Grok.
const REVIEW_PROMPT = `Fais une code review des modifications de ce dépôt.

Périmètre : les modifications non commitées (git diff HEAD, plus les fichiers non suivis). S'il n'y en a aucune, les commits pas encore poussés (git log @{upstream}..HEAD) ; sans upstream, le dernier commit.

Cherche en priorité les bugs de correction (logique, cas limites, concurrence, erreurs non gérées, régressions), puis les problèmes de sécurité, puis la simplification et la réutilisation du code existant. Vérifie chaque finding en lisant le code autour avant de le rapporter ; écarte ce que tu ne peux pas étayer.

Ne modifie aucun fichier. Rapporte les findings du plus grave au moins grave, chacun avec fichier:ligne, le problème, un scénario concret qui le déclenche et le correctif attendu. Termine en me demandant si je veux les corriger maintenant ou les mettre dans le backlog Cerebro (en epic).`;

// Claude a sa propre commande de review ; les autres agents reçoivent le prompt générique.
const reviewPromptFor = (agent: Agent): string => (agent === 'claude' ? '/code-review' : REVIEW_PROMPT);

const hasGitWork = (git: GitInfo): boolean =>
  git.dirty > 0 || (git.ahead ?? 0) > 0 || (git.hasCommits && !git.hasUpstream);

// 'repo' : nouvelle session sur tout le dépôt ; 'session' : prompt envoyé à une session existante,
// limité à ce qu'elle a modifié (d'autres sessions peuvent travailler en parallèle dans le dépôt).
type Scope = 'repo' | 'session';

const SESSION_SCOPE = `D'autres sessions peuvent travailler en parallèle dans ce dépôt : limite-toi strictement aux fichiers que tu as créés ou modifiés au cours de cette session, et dans ces fichiers aux hunks qui viennent de toi. Ignore tout le reste et laisse-le intact.`;

const SESSION_REVIEW_PROMPT = `Fais une code review des modifications que tu as faites dans cette session.

Périmètre : ${SESSION_SCOPE} Commence par lister ces fichiers, puis lis leur diff (git diff HEAD -- <fichiers>, ou leur contenu s'ils ne sont pas suivis) ; si tu as déjà commité une partie de ton travail, inclus aussi ces commits.

Cherche en priorité les bugs de correction (logique, cas limites, concurrence, erreurs non gérées, régressions), puis les problèmes de sécurité, puis la simplification et la réutilisation du code existant. Vérifie chaque finding en lisant le code autour avant de le rapporter ; écarte ce que tu ne peux pas étayer. Relis ton code d'un œil neuf, comme s'il venait de quelqu'un d'autre.

Ne modifie aucun fichier. Rapporte les findings du plus grave au moins grave, chacun avec fichier:ligne, le problème, un scénario concret qui le déclenche et le correctif attendu. Termine en me demandant si je veux les corriger maintenant ou les mettre dans le backlog Cerebro (en epic).`;

const PUSH_RULE = `Pousse la branche courante sur chaque remote configuré (liste-les avec git remote -v). Si elle n'a pas d'upstream, pose-le avec -u sur origin (ou sur le seul remote s'il n'y en a qu'un). Jamais de force push et n'utilise jamais --no-verify. Si un hook échoue ou si un push est refusé sur un remote, ne contourne rien : continue avec les remotes suivants, puis explique-moi la situation.`;

const PUSH_ONLY_PROMPT = `Pousse les commits existants de la branche courante. Ne modifie ni les fichiers ni l'index et ne crée aucun commit. ${PUSH_RULE}

Termine par le résultat du push pour chaque remote.`;

function commitPrompt(strategy: CommitStrategy, push: boolean, scope: Scope): string {
  const what = scope === 'session' ? 'les modifications que tu as faites dans cette session' : 'les modifications en cours de ce dépôt';
  const scopeRule = scope === 'session' ? `\n\n${SESSION_SCOPE} Quand un fichier mêle tes changements et ceux d'une autre origine, n'indexe que tes hunks (git add -p, ou git apply --cached d'un patch partiel). Signale à la fin les fichiers modifiés que tu as laissés de côté parce qu'ils ne viennent pas de toi.` : '';
  const common = `Avant tout, lis git status (fichiers suivis et non suivis), git diff HEAD, git diff --cached et git log -n 15 pour suivre les conventions de messages du dépôt (langue, format, préfixes).${scopeRule}

Avant toute indexation, examine les fichiers candidats et trie les changements : n'indexe et ne commite aucun secret, fichier généré ou temporaire. Vérifie aussi les changements déjà indexés pour ne pas les embarquer. Pour tout fichier douteux, demande-moi confirmation avant de l'indexer ou de le commiter et attends ma réponse. Indexe explicitement uniquement les fichiers ou hunks retenus après ce tri. Ne pousse qu'une fois ce tri terminé, le contenu de l'index vérifié et tous les doutes levés.

N'utilise jamais --no-verify ; si un hook échoue, corrige la cause ou demande-moi.`;
  const pushStep = push
    ? `Une fois les commits faits : ${PUSH_RULE} Donne le résultat du push pour chaque remote.`
    : `Ne pousse pas.`;
  if (strategy === 'single') {
    return `Commite ${what} retenues après le tri ci-dessous en un seul commit.

${common}

Écris un message dont le titre résume l'ensemble et dont le corps liste les changements principaux.

${pushStep}

Termine par le hash et le titre du commit.`;
  }
  return `Commite ${what} sous forme de commits propres et atomiques.

${common}

Regroupe les changements retenus après ce tri par intention : un commit = un changement logique cohérent (une fonctionnalité, un correctif, un refactoring, la doc qui va avec). Quand un fichier mêle plusieurs intentions, découpe-le par hunks (git add -p, ou git apply --cached d'un patch partiel). Ordonne les commits pour que chacun soit cohérent et compile seul : les fondations (types, utilitaires, refactorings préparatoires) avant ce qui en dépend. Présente-moi d'abord le plan (commits dans l'ordre, fichiers et message de chacun), puis exécute-le sans attendre ma validation sauf si un regroupement est ambigu ou si un fichier est douteux. Vérifie à la fin avec git status que tous les changements retenus ont été commités ; signale les fichiers exclus sans les indexer.

${pushStep}

Termine par la liste des commits créés (hash et titre).`;
}

function repoCommitPrompt(strategy: CommitStrategy, push: boolean, dirty: number, ahead: number | null): string {
  if (dirty > 0) return commitPrompt(strategy, push, 'repo');
  return push && ahead !== 0 ? PUSH_ONLY_PROMPT : '';
}

// La session se lance en arrière-plan : on reste sur la page projet.
function useLaunch(projectId: string, onDone: () => void): (spec: LaunchSpec) => Promise<void> {
  const { createSession } = useStore();
  return async (spec) => {
    await createSession(projectId, spec);
    onDone();
  };
}

function CommitDialog({ projectId, git, onClose }: { projectId: string; git: GitInfo; onClose: () => void }) {
  const [strategy, setStrategy] = useState<CommitStrategy>('atomic');
  const [push, setPush] = useState(true);
  const launch = useLaunch(projectId, onClose);
  const nothingToCommit = git.dirty === 0;
  const { dirty, ahead } = git;
  const promptFor = useCallback(() => repoCommitPrompt(strategy, push, dirty, ahead), [strategy, push, dirty, ahead]);
  const launchDisabled = nothingToCommit && (!push || !hasGitWork(git));

  return (
    <Modal title="Commit / push" onClose={onClose}>
      <div className="commit-options">
        <ChoiceGroup<CommitStrategy>
          compact
          label="Stratégie"
          value={strategy}
          options={[
            { value: 'atomic', label: 'Commits atomiques', title: "L'agent découpe les changements en commits ordonnés" },
            { value: 'single', label: 'Un seul commit', title: 'Toutes les modifications en cours dans un commit' },
          ]}
          onChange={setStrategy}
        />
        <label className="slack-toggle">
          <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
          Pousser ensuite
        </label>
      </div>
      {nothingToCommit ? (
        <p className="meta">
          {push && !launchDisabled
            ? "Aucune modification en cours : l'agent poussera seulement les commits existants."
            : "Aucune modification en cours : l'agent n'aura rien à commiter."}
        </p>
      ) : null}
      {/* Options et état git régénèrent seulement le prompt non édité, en conservant les réglages de session. */}
      <NewSessionForm
        className="bare"
        projectId={projectId}
        initialPrompt={repoCommitPrompt(strategy, push, dirty, ahead)}
        promptFor={promptFor}
        launchDisabled={launchDisabled}
        autoFocus
        onLaunch={launch}
        onCancel={onClose}
      />
    </Modal>
  );
}

export function GitActions({ projectId, git }: { projectId: string; git: GitInfo }) {
  const [open, setOpen] = useState<'review' | 'commit' | null>(null);
  const close = (): void => setOpen(null);
  const launchReview = useLaunch(projectId, close);
  const hasWork = hasGitWork(git);

  return (
    <>
      <span className="git-actions">
        <button type="button" className="btn" onClick={() => setOpen('review')} title="Lancer une session de code review">
          Code review
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setOpen('commit')}
          disabled={!hasWork}
          title={hasWork ? 'Lancer une session qui commite (et pousse) les modifications' : 'Rien à commiter ni à pousser'}
        >
          Commit / push
        </button>
      </span>
      {open === 'review' ? (
        <LaunchSessionDialog
          title="Code review"
          projectId={projectId}
          initialPrompt={REVIEW_PROMPT}
          promptFor={reviewPromptFor}
          onLaunch={launchReview}
          onClose={close}
        />
      ) : null}
      {open === 'commit' ? <CommitDialog projectId={projectId} git={git} onClose={close} /> : null}
    </>
  );
}

// Collage « bracketed paste » : le texte multiligne arrive d'un bloc dans la TUI de l'agent
// au lieu d'être soumis à chaque saut de ligne.
const pasted = (text: string): string => `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`;

function SendToSessionDialog({
  title,
  sessionId,
  prompt,
  children,
  onClose,
}: {
  title: string;
  sessionId: string;
  prompt: string;
  children?: ReactNode;
  onClose: () => void;
}) {
  const { sendSessionInput } = useStore();
  // Les options régénèrent le prompt tant qu'il n'a pas été édité à la main.
  const [edited, setEdited] = useState<string | null>(null);
  const text = edited ?? prompt;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (): Promise<void> => {
    if (busy || text.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await sendSessionInput(sessionId, pasted(text.trim()));
      // Deux envois distincts : certaines TUI ignorent l'Entrée collée au texte.
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      await sendSessionInput(sessionId, '\r');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Envoi impossible');
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      {children}
      <form
        className="task-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          autoFocus
          rows={14}
          value={text}
          onChange={(e) => setEdited(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
            if (isSubmitShortcut(e)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {error ? <p className="form-error">{error}</p> : null}
        <div className="row-actions">
          <button type="submit" className="btn primary" disabled={busy || text.trim() === ''}>
            Envoyer à la session
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          {edited !== null ? (
            <button type="button" className="btn" onClick={() => setEdited(null)}>
              Rétablir le prompt
            </button>
          ) : null}
          <span className="hint">{SUBMIT_HINT}</span>
        </div>
      </form>
    </Modal>
  );
}

function SessionCommitDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [strategy, setStrategy] = useState<CommitStrategy>('atomic');
  const [push, setPush] = useState(true);
  return (
    <SendToSessionDialog title="Commit / push de la session" sessionId={sessionId} prompt={commitPrompt(strategy, push, 'session')} onClose={onClose}>
      <div className="commit-options">
        <ChoiceGroup<CommitStrategy>
          compact
          label="Stratégie"
          value={strategy}
          options={[
            { value: 'atomic', label: 'Commits atomiques', title: "L'agent découpe ses changements en commits ordonnés" },
            { value: 'single', label: 'Un seul commit', title: "Tous les changements de la session dans un commit" },
          ]}
          onChange={setStrategy}
        />
        <label className="slack-toggle">
          <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
          Pousser ensuite
        </label>
      </div>
    </SendToSessionDialog>
  );
}

// Dans une session : le prompt est envoyé à la session elle-même, qui sait quels fichiers elle a touchés.
export function SessionGitActions({ sessionId, live }: { sessionId: string; live: boolean }) {
  const [open, setOpen] = useState<'review' | 'commit' | null>(null);
  const close = (): void => setOpen(null);
  const why = live ? undefined : 'Session arrêtée : reprends-la pour lui envoyer la demande';

  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={!live}
        onClick={() => setOpen('review')}
        title={why ?? 'Demander à la session une code review de ses propres modifications'}
      >
        Code review
      </button>
      <button
        type="button"
        className="btn"
        disabled={!live}
        onClick={() => setOpen('commit')}
        title={why ?? 'Demander à la session de commiter (et pousser) ses propres modifications'}
      >
        Commit / push
      </button>
      {open === 'review' ? (
        <SendToSessionDialog title="Code review de la session" sessionId={sessionId} prompt={SESSION_REVIEW_PROMPT} onClose={close} />
      ) : null}
      {open === 'commit' ? <SessionCommitDialog sessionId={sessionId} onClose={close} /> : null}
    </>
  );
}
