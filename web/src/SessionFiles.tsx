import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { apiParsed, apiPath } from './api.ts';
import { errorMessage } from './format.ts';
import { usePolling } from './polling.tsx';
import { Markdown } from './Markdown.tsx';
import { readStored, writeStored } from './storage.ts';
import './session-files.css';
import {
  citation,
  fileLines,
  filterFiles,
  isMarkdown,
  parseFileList,
  parseFileRead,
  FILE_RESULTS_MAX,
} from './session-files.ts';

// « Fichiers » panel beside the session terminal: read-only view of the session's working folder, with a
// button that quotes the selected lines into « Envoyer un message ».
// [SPEC: Interface › Vue session desktop, panneau « Fichiers »]

const WIDTH_KEY = 'cerebro.sessionFilesWidth';
const fileKey = (sessionId: string): string => `cerebro.sessionFile.${sessionId}`;
const MIN_WIDTH = 240;
const MAX_SHARE = 0.7;
const REFRESH_MS = 2_000;

interface Doc {
  path: string;
  version: string;
  content: string;
  lines: string[];
}

interface Quote {
  start: number;
  end: number;
  text: string;
}

function readWidth(): number | null {
  const value = Number(readStored(WIDTH_KEY));
  return Number.isFinite(value) && value >= MIN_WIDTH ? value : null;
}

const lineOf = (element: Element): number => Number((element as HTMLElement).dataset.line);
const lastLineOf = (element: Element): number =>
  Number((element as HTMLElement).dataset.lineEnd ?? (element as HTMLElement).dataset.line);

/**
 * Element tagged with source lines (`data-line`) that holds a selection boundary. A boundary between
 * blocks (rendered Markdown: between a list and a paragraph) takes the nearest tagged element: the
 * next one for the start, the previous one for the end.
 */
function boundaryElement(container: HTMLElement, node: Node, offset: number, edge: 'start' | 'end'): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  const own = element?.closest('[data-line]');
  if (own && container.contains(own)) return own;
  const tagged = [...container.querySelectorAll('[data-line]')];
  const point = document.createRange();
  point.setStart(node, offset);
  const before = (candidate: Element): boolean => point.comparePoint(candidate, 0) < 0;
  return edge === 'start' ? (tagged.find((e) => !before(e)) ?? null) : (tagged.findLast(before) ?? null);
}

function selectedQuote(container: HTMLElement): Quote | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString();
  const first = boundaryElement(container, range.startContainer, range.startOffset, 'start');
  let last = boundaryElement(container, range.endContainer, range.endOffset, 'end');
  if (first === null || last === null || text.trim() === '') return null;
  // A triple click ends the range at the very start of the next block: nothing of it is selected.
  if (last !== first) {
    const inLast = document.createRange();
    inLast.setStart(last, 0);
    inLast.setEnd(range.endContainer, range.endOffset);
    if (inLast.toString().trim() === '') {
      const tagged = [...container.querySelectorAll('[data-line]')];
      last = tagged[tagged.indexOf(last) - 1] ?? last;
    }
  }
  const start = lineOf(first);
  const end = Math.max(start, lastLineOf(last));
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  return { start, end, text };
}

// Memoized: every selection change re-renders the panel, and a long file has thousands of lines.
const FileLines = memo(function FileLines({ lines }: { lines: string[] }) {
  return lines.map((line, index) => (
    <div key={index} className="file-line" data-line={index + 1}>
      {line}
    </div>
  ));
});

const RenderedMarkdown = memo(function RenderedMarkdown({ content }: { content: string }) {
  return <Markdown text={content} className="file-markdown" sourceLines headingShift={0} />;
});

/**
 * File list and read-only view of a session's working folder, with « Citer » on a selection. Shared by the desktop
 * panel and the « Fichiers » tab of the mobile session screen. Nothing is read while `active` is false (inactive
 * mobile tab); the list is read again each time it becomes active. `focusSearch`: the search field takes focus
 * when the user goes back to the list (false on a phone, where it would open the keyboard).
 */
export function SessionFilesBrowser({
  sessionId,
  live,
  onCite,
  citeLabel,
  active = true,
  focusSearch: focusOnBrowse = true,
}: {
  sessionId: string;
  live: boolean;
  onCite: (text: string) => void;
  citeLabel: string;
  active?: boolean;
  focusSearch?: boolean;
}) {
  const linesRef = useRef<HTMLDivElement>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [path, setPathState] = useState<string | null>(() => readStored(fileKey(sessionId)));
  const [browsing, setBrowsing] = useState(path === null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [showSource, setShowSource] = useState(false);
  const rendered = path !== null && isMarkdown(path) && !showSource;
  const known = useRef<string | null>(null);
  // The search field takes focus only on an explicit request: on mount, the terminal keeps it.
  const searchRef = useRef<HTMLInputElement>(null);
  const focusSearch = useRef(false);

  useEffect(() => {
    if (!browsing || !focusSearch.current) return;
    focusSearch.current = false;
    searchRef.current?.focus();
  }, [browsing]);

  const setPath = (next: string | null): void => {
    setPathState(next);
    writeStored(fileKey(sessionId), next);
  };

  const loadFiles = useCallback(async (): Promise<void> => {
    setListError(null);
    try {
      const list = await apiParsed(apiPath`/api/sessions/${sessionId}/files`, parseFileList);
      setFiles(list.files);
      setTruncated(list.truncated);
    } catch (err) {
      setFiles(null);
      setListError(errorMessage(err, 'Liste des fichiers indisponible'));
    }
  }, [sessionId]);

  useEffect(() => {
    if (active) void loadFiles();
  }, [active, loadFiles]);

  // A new file starts from scratch: no version known, nothing shown from the previous one.
  useEffect(() => {
    known.current = null;
    setDoc(null);
    setReadError(null);
    setQuote(null);
  }, [path]);

  const fetchFile = useCallback(async () => {
    if (path === null) return null;
    const params = new URLSearchParams({ path });
    if (known.current !== null) params.set('known', known.current);
    return apiParsed(`${apiPath`/api/sessions/${sessionId}/file`}?${params.toString()}`, parseFileRead);
  }, [sessionId, path]);

  usePolling(fetchFile, REFRESH_MS, {
    enabled: active && path !== null && !browsing,
    onData: (read) => {
      setReadError(null);
      // Same version: the DOM is left alone, so the user's selection survives the refresh.
      if (read === null || 'unchanged' in read) return;
      known.current = read.version;
      setDoc({ path: read.path, version: read.version, content: read.content, lines: fileLines(read.content) });
    },
    onError: (err) => {
      known.current = null;
      setDoc(null);
      setReadError(errorMessage(err, 'Lecture du fichier impossible'));
    },
  });

  useEffect(() => {
    const onSelection = (): void => {
      const container = linesRef.current;
      setQuote(container ? selectedQuote(container) : null);
    };
    document.addEventListener('selectionchange', onSelection);
    return () => document.removeEventListener('selectionchange', onSelection);
  }, []);

  const cite = (): void => {
    if (!quote || !doc) return;
    onCite(citation(doc.path, quote.start, quote.end, quote.text));
    window.getSelection()?.removeAllRanges();
    setQuote(null);
  };

  const shown = files === null ? [] : filterFiles(files, query);
  const open = (file: string): void => {
    setPath(file);
    setBrowsing(false);
  };
  const browse = (): void => {
    focusSearch.current = focusOnBrowse;
    setBrowsing(true);
  };

  return (
    <>
      <div className="session-files-bar">
        {browsing ? (
          <input
            className="session-files-search"
            type="search"
            ref={searchRef}
            value={query}
            placeholder="Rechercher un fichier"
            aria-label="Rechercher un fichier"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && shown[0] !== undefined) open(shown[0]);
              else if (e.key === 'Escape' && path !== null) {
                e.stopPropagation();
                setBrowsing(false);
              }
            }}
          />
        ) : (
          <button type="button" className="session-files-path" title="Changer de fichier" onClick={browse}>
            {path}
          </button>
        )}
        {!browsing && path !== null && isMarkdown(path) ? (
          <button
            type="button"
            className="btn"
            aria-pressed={!showSource}
            title={showSource ? 'Afficher le Markdown rendu' : 'Afficher la source du fichier'}
            onClick={() => {
              window.getSelection()?.removeAllRanges();
              setShowSource(!showSource);
            }}
          >
            {showSource ? 'Rendu' : 'Source'}
          </button>
        ) : null}
        {!browsing && path !== null ? (
          <button
            type="button"
            className="btn"
            title="Fermer ce fichier et revenir à la liste des fichiers"
            onClick={() => {
              window.getSelection()?.removeAllRanges();
              setPath(null);
              browse();
            }}
          >
            Fermer
          </button>
        ) : null}
        {browsing && path !== null ? (
          <button type="button" className="btn" onClick={() => setBrowsing(false)}>
            Retour
          </button>
        ) : null}
        {browsing ? (
          <button type="button" className="btn" title="Relire la liste des fichiers" onClick={() => void loadFiles()}>
            Actualiser
          </button>
        ) : null}
      </div>
      {browsing ? (
        <div className="session-files-list">
          {listError ? <p className="form-error">{listError}</p> : null}
          {files === null && listError === null ? <p className="empty-hint">Chargement…</p> : null}
          {files !== null && shown.length === 0 ? <p className="empty-hint">Aucun fichier.</p> : null}
          <ul>
            {shown.map((file) => (
              <li key={file}>
                <button type="button" className={file === path ? 'active' : undefined} onClick={() => open(file)}>
                  {file}
                </button>
              </li>
            ))}
          </ul>
          {truncated ? (
            <p className="empty-hint">
              Dossier hors Git trop grand : seuls ses {files?.length ?? 0} premiers fichiers sont listés.
            </p>
          ) : null}
          {files !== null && shown.length === FILE_RESULTS_MAX ? (
            <p className="empty-hint">{FILE_RESULTS_MAX} premiers résultats : précisez la recherche.</p>
          ) : null}
        </div>
      ) : (
        <div className="session-files-view">
          {readError ? <p className="form-error">{readError}</p> : null}
          {doc === null && readError === null ? <p className="empty-hint">Chargement…</p> : null}
          {doc !== null ? (
            <div ref={linesRef} className={rendered ? 'file-rendered' : 'file-lines'}>
              {rendered ? <RenderedMarkdown content={doc.content} /> : <FileLines lines={doc.lines} />}
            </div>
          ) : null}
          {quote && doc ? (
            // preventDefault on mousedown: the click must not clear the selection. A tap on a phone clears it
            // before the click: there the quote is taken on pointerdown.
            <div className="selection-bar session-files-quote" onMouseDown={(e) => e.preventDefault()}>
              <button
                type="button"
                className="btn primary"
                disabled={!live}
                title={live ? undefined : 'La session est terminée'}
                onPointerDown={(e) => {
                  if (e.pointerType === 'mouse') return;
                  e.preventDefault();
                  cite();
                }}
                onClick={cite}
              >
                {citeLabel}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}

/** Desktop panel left of the terminal, with a resizable width. */
export function SessionFilesPanel({
  sessionId,
  live,
  onCite,
}: {
  sessionId: string;
  live: boolean;
  onCite: (text: string) => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [width, setWidthState] = useState<number | null>(readWidth);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number; max: number } | null>(null);

  useEffect(() => {
    if (!dragging) return;
    // While dragging, the cursor must not select text nor be captured by xterm.
    document.body.classList.add('session-files-resizing');
    return () => document.body.classList.remove('session-files-resizing');
  }, [dragging]);

  const setWidth = (next: number | null, max?: number): void => {
    const clamped = next === null ? null : Math.round(Math.max(MIN_WIDTH, Math.min(max ?? Infinity, next)));
    setWidthState(clamped);
    writeStored(WIDTH_KEY, clamped === null ? null : String(clamped));
  };
  const maxWidth = (): number => {
    const body = panelRef.current?.parentElement;
    return Math.max(MIN_WIDTH, (body?.clientWidth ?? window.innerWidth) * MAX_SHARE);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      startX: event.clientX,
      startWidth: panelRef.current?.getBoundingClientRect().width ?? MIN_WIDTH,
      max: maxWidth(),
    };
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (current) setWidth(current.startWidth + event.clientX - current.startX, current.max);
  };
  const endDrag = (): void => {
    drag.current = null;
    setDragging(false);
  };

  return (
    <aside
      ref={panelRef}
      className="session-files"
      aria-label="Fichiers de la session"
      style={width === null ? undefined : { flexBasis: `${width}px` }}
    >
      <SessionFilesBrowser sessionId={sessionId} live={live} onCite={onCite} citeLabel="Citer dans le message" />
      <div
        className={`session-files-resizer${dragging ? ' dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Redimensionner le panneau des fichiers"
        tabIndex={0}
        title="Glisser pour redimensionner, double-clic pour la largeur par défaut"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => setWidth(null)}
        onKeyDown={(event) => {
          const current = panelRef.current?.getBoundingClientRect().width ?? MIN_WIDTH;
          if (event.key === 'ArrowLeft') setWidth(current - 16, maxWidth());
          else if (event.key === 'ArrowRight') setWidth(current + 16, maxWidth());
          else return;
          event.preventDefault();
        }}
      />
    </aside>
  );
}
