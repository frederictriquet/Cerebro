import type { Status } from './types.ts';

export function StatusDot({ status, title }: { status: Status; title?: string }) {
  return <span className={`dot ${status}`} title={title ?? status} />;
}
