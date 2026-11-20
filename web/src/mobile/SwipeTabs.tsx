import { useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { dragOffset, gestureAxis, swipeTarget } from './swipe.ts';

export interface SwipeTab<K extends string> {
  id: K;
  label: string;
  badge?: ReactNode;
  content: ReactNode;
  /** Classes of the panel: `m-content` for a panel that scrolls. */
  className?: string;
}

interface Drag {
  pointerId: number;
  x: number;
  y: number;
  axis: 'x' | 'y' | null;
}

// A drag that starts in a field selects text or moves the caret: it never changes tab.
const NO_SWIPE = 'textarea, input, select';

/**
 * Mobile tabs changed by a tap on the tab bar or a horizontal swipe on the panels. [SPEC: vue mobile, onglets à
 * balayage] Every panel stays mounted (a draft or a scroll position survives a tab change); the inactive ones are
 * `inert`, out of view. The drag offset lives here, so a pointer move re-renders neither the panels nor the screen
 * that owns them (their elements arrive unchanged in `tabs`).
 */
export function SwipeTabs<K extends string>({
  label,
  idPrefix,
  tabs,
  value,
  onChange,
}: {
  label: string;
  idPrefix: string;
  tabs: readonly SwipeTab<K>[];
  value: K;
  onChange: (id: K) => void;
}) {
  const index = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === value),
  );
  const [dx, setDx] = useState(0);
  const drag = useRef<Drag | null>(null);
  // A swipe released over a link or a button must not also click it.
  const swiped = useRef(false);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    swiped.current = false;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(NO_SWIPE) !== null) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, axis: null };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    const moveX = event.clientX - current.x;
    if (current.axis === null) {
      current.axis = gestureAxis(moveX, event.clientY - current.y);
      // Once horizontal, the release reaches the viewport even outside it; the click it would end with is dropped.
      if (current.axis === 'x') event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (current.axis === 'x') setDx(moveX);
  };

  const end = (event: PointerEvent<HTMLDivElement>, cancelled: boolean): void => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (current.axis !== 'x') return;
    swiped.current = true;
    const target = cancelled ? index : swipeTarget(index, tabs.length, event.clientX - current.x);
    setDx(0);
    const next = tabs[target];
    if (next !== undefined && target !== index) onChange(next.id);
  };

  const onClickCapture = (event: MouseEvent<HTMLDivElement>): void => {
    if (!swiped.current) return;
    swiped.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const dragging = dx !== 0;
  const offset = dragOffset(index, tabs.length, dx);
  return (
    <div className="m-swipe">
      <div className="m-tabs" role="tablist" aria-label={label}>
        {tabs.map((tab, i) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={i === index}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            className="m-tab"
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {tab.badge}
          </button>
        ))}
      </div>
      <div
        className="m-swipe-viewport"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => end(event, false)}
        onPointerCancel={(event) => end(event, true)}
        onClickCapture={onClickCapture}
      >
        {tabs.map((tab, i) => (
          <section
            key={tab.id}
            role="tabpanel"
            id={`${idPrefix}-panel-${tab.id}`}
            aria-labelledby={`${idPrefix}-tab-${tab.id}`}
            className={`m-swipe-panel${tab.className === undefined ? '' : ` ${tab.className}`}${dragging ? ' dragging' : ''}`}
            inert={i !== index}
            style={{ transform: `translateX(calc(${(i - index) * 100}% + ${offset}px))` }}
          >
            {tab.content}
          </section>
        ))}
      </div>
    </div>
  );
}
