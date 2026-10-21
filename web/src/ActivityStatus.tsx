import type { ReactNode } from 'react';
import './activity-status.css';

// Keep the label readable and announced; the spinner itself is decorative.
export function ActivityStatus({ active = true, children }: { active?: boolean; children: ReactNode }) {
  return (
    <span className="activity-status" role="status" aria-atomic="true">
      {active ? <span className="activity-spinner" aria-hidden="true" /> : null}
      <span>{children}</span>
    </span>
  );
}
