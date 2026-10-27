import type { ReactNode } from 'react';
import type { MergeStepState } from './model.ts';

const STEP_LABEL: Record<MergeStepState, string> = {
  done: 'Fait',
  todo: 'À faire',
  blocked: 'Bloqué',
  waiting: 'En attente',
};
export function Step({
  number,
  title,
  state,
  children,
}: {
  number: number;
  title: string;
  state: MergeStepState;
  children?: ReactNode;
}) {
  return (
    <li className={`worktree-step worktree-step-${state}`}>
      <div className="worktree-step-heading">
        <span className="worktree-step-number" aria-hidden="true">
          {state === 'done' ? '✓' : number}
        </span>
        <strong>{title}</strong>
        <span className="worktree-step-state">{STEP_LABEL[state]}</span>
      </div>
      {children ? <div className="worktree-step-body">{children}</div> : null}
    </li>
  );
}
