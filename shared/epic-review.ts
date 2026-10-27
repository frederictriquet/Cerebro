// Partagé par le serveur (server/epic-review.ts) et l'interface (web/src/EpicReviewActions.tsx).

/** First line of the final review step added by « Ajouter une étape de review » ; the runner completes its prompt at launch. */
export const REVIEW_TASK_TITLE = 'Code review du travail de l’epic';
export const isReviewTask = (task: { text: string }): boolean => task.text.split('\n')[0] === REVIEW_TASK_TITLE;
