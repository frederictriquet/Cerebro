// Contrat entre les commits que Cerebro écrit lui-même (worktrees.ts) et la provenance d'une
// session (provenance.ts) : l'historique d'une branche de session n'est attribuable que si son
// reflog ne contient que sa création et des commits, au format écrit par `git commit` / `git merge`.

export const BRANCH_CREATED_REFLOG = 'branch: Created from';

/** Message de reflog d'un commit de fusion écrit par `update-ref`, identique à celui de `git merge`. */
export const mergeCommitReflog = (message: string): string => `commit (merge): ${message}`;

const KNOWN_HISTORY = /^(?:commit(?: \([^)]*\))?:|branch: Created from)/;

/** Le reflog (`%gs`, une entrée par ligne) ne contient que la création de la branche et des commits. */
export const reflogHistoryKnown = (reflog: string): boolean =>
  reflog.includes(BRANCH_CREATED_REFLOG) && !reflog.split('\n').some((line) => line && !KNOWN_HISTORY.test(line));
