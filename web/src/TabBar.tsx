import { useRef, useState, type KeyboardEvent } from 'react';
import { readStored, writeStored } from './storage.ts';

export interface TabSpec<T extends string> {
  id: T;
  label: string;
  count?: { value: number; title: string };
}

/** Identifiants qui relient un onglet à son panneau. */
export function tabIds(idPrefix: string, id: string): { tab: string; panel: string } {
  return { tab: `${idPrefix}-tab-${id}`, panel: `${idPrefix}-panel-${id}` };
}

/** Onglet sélectionné, retenu par ce navigateur ; le premier par défaut. */
export function useStoredTab<T extends string>(key: string, ids: readonly T[]): [T, (tab: T) => void] {
  const [tab, setTab] = useState<T>(() => ids.find((id) => id === readStored(key)) ?? ids[0]);
  const select = (next: T): void => {
    setTab(next);
    writeStored(key, next);
  };
  return [tab, select];
}

export function TabBar<T extends string>({
  idPrefix,
  label,
  tabs,
  selected,
  onSelect,
}: {
  idPrefix: string;
  label: string;
  tabs: readonly TabSpec<T>[];
  selected: T;
  onSelect: (tab: T) => void;
}) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const onKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = tabs.findIndex((t) => t.id === selected);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex].id;
    onSelect(next);
    buttons.current.get(next)?.focus();
  };
  return (
    <div className="view-tabs" role="tablist" aria-label={label}>
      {tabs.map(({ id, label: tabLabel, count }) => {
        const ids = tabIds(idPrefix, id);
        return (
          <button
            key={id}
            ref={(el) => {
              if (el) buttons.current.set(id, el);
              else buttons.current.delete(id);
            }}
            type="button"
            role="tab"
            id={ids.tab}
            aria-selected={selected === id}
            aria-controls={ids.panel}
            tabIndex={selected === id ? 0 : -1}
            onClick={() => onSelect(id)}
            onKeyDown={onKey}
          >
            {tabLabel}
            {count ? (
              <span className="pill project-panel-count" title={count.title}>
                {count.value}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
