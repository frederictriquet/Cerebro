import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { useLatest } from './use-latest.ts';
import { clipboardImage, readClipboardImage, uploadImage, wsUrl } from './api.ts';
import { errorMessage } from './format.ts';
import { openReconnectingSocket, type ReconnectingSocket } from './reconnectingSocket.ts';
import { parseTermServerMessage, type TermClientMessage } from '../../shared/types.ts';

const FONT = 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace';
// Frappes conservées pendant une reconnexion ; au-delà, elles sont refusées et signalées.
const MAX_PENDING_INPUT = 4096;

interface LinkState {
  reconnecting: boolean;
  pending: number;
  dropped: boolean;
}

const LINK_OPEN: LinkState = { reconnecting: false, pending: 0, dropped: false };

export interface TermApi {
  sendInput: (data: string) => boolean;
  sendArrow: (direction: 'up' | 'down') => boolean;
  focus: () => void;
  getSelection: () => string;
  /** Réajuste le PTY à cette fenêtre et force l'application à se redessiner. */
  refreshSize: () => boolean;
}

// Texte sélectionné à l'écran : sans espaces de fin de ligne, lignes vides de bord,
// ni l'indentation commune ajoutée par les TUI.
export function cleanSelection(raw: string): string {
  const lines = raw.split(/\r?\n/).map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const indents = lines.filter((line) => line !== '').map((line) => /^ */.exec(line)?.[0].length ?? 0);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(indent)).join('\n');
}

function send(ws: WebSocket | null, msg: TermClientMessage): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

export function Term({
  sessionId,
  onApi,
  onSelectionChange,
  onEscape,
}: {
  sessionId: string;
  onApi?: (api: TermApi | null) => void;
  onSelectionChange?: (hasSelection: boolean) => void;
  onEscape?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onApiRef = useLatest(onApi);
  const onSelectionRef = useLatest(onSelectionChange);
  const onEscapeRef = useLatest(onEscape);
  const [link, setLink] = useState<LinkState>(LINK_OPEN);
  // Taille imposée par un autre poste qui affiche la même session, null quand c'est la nôtre.
  const [borrowed, setBorrowed] = useState<{ cols: number; rows: number } | null>(null);
  const claimRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: FONT,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: '#0b0d11',
        foreground: '#d7dee8',
        cursor: '#d7dee8',
        cursorAccent: '#0b0d11',
        selectionBackground: '#2a3548',
        black: '#0b0d11',
        red: '#e25c6a',
        green: '#3ecf8e',
        yellow: '#e6c07b',
        blue: '#7aa2f7',
        magenta: '#c792ea',
        cyan: '#56b6c2',
        white: '#d7dee8',
        brightBlack: '#6a7382',
        brightRed: '#ff7b86',
        brightGreen: '#5ce0a5',
        brightYellow: '#f0d189',
        brightBlue: '#9bbcf9',
        brightMagenta: '#d4a6f3',
        brightCyan: '#7ad4de',
        brightWhite: '#ffffff',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.attachCustomKeyEventHandler((event) => {
      // xterm traduit Ctrl+V en ^V et annule l'événement : le navigateur ne colle alors jamais.
      // On le lui laisse, pour que l'événement paste (texte ou image) ait lieu.
      if (event.type === 'keydown') claimNow();
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'KeyV') return false;
      // Échap seul est réservé à Cerebro (retour au projet) ; Maj+Échap et le bouton rapide l'envoient à la session.
      const escape = onEscapeRef.current;
      if (
        escape &&
        event.key === 'Escape' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.isComposing
      ) {
        if (event.type === 'keydown') {
          event.preventDefault();
          escape();
        }
        return false;
      }
      return true;
    });
    term.open(host);
    term.focus();

    let link: ReconnectingSocket | null = null;
    const current = (): WebSocket | null => link?.current() ?? null;
    let closed = false;
    // Le PTY n'a qu'une taille : tous les postes qui l'affichent doivent la reprendre à l'identique,
    // sinon chacun redécoupe à sa largeur un écran tracé pour une autre. Le dernier poste actif
    // (frappe, clic, focus) l'impose à sa fenêtre, les autres s'y alignent.
    let ptyCols = 0;
    let ptyRows = 0;
    let fitCols = 0;
    let fitRows = 0;
    // Dernière taille demandée par ce poste : il garde la main tant que le serveur confirme celle-là.
    let claimedCols = 0;
    let claimedRows = 0;
    let owner = false;
    let connected = false;
    let lastBorrowed = '';
    let reconnecting = false;
    let pending = '';
    let dropped = false;

    const publishLink = (): void => {
      if (closed) return;
      setLink(reconnecting ? { reconnecting, pending: pending.length, dropped } : LINK_OPEN);
    };

    // Saisie clavier : mise en attente si le socket n'est pas ouvert, puis envoyée à la reconnexion.
    const input = (data: string): void => {
      if (pending === '' && send(current(), { type: 'input', data })) return;
      if (pending.length + data.length > MAX_PENDING_INPUT) {
        dropped = true;
      } else {
        pending += data;
      }
      publishLink();
    };

    const flushPending = (): void => {
      if (pending !== '' && send(current(), { type: 'input', data: pending })) pending = '';
      dropped = false;
      publishLink();
    };

    const api: TermApi = {
      // Saisie ou boutons rapides de ce poste : il reprend la main sur la taille.
      sendInput(data: string): boolean {
        claim();
        return send(current(), { type: 'input', data });
      },
      sendArrow(direction: 'up' | 'down'): boolean {
        claim();
        const application = term.modes.applicationCursorKeysMode;
        const data = direction === 'up' ? (application ? '\x1bOA' : '\x1b[A') : application ? '\x1bOB' : '\x1b[B';
        return send(current(), { type: 'input', data });
      },
      focus(): void {
        term.focus();
      },
      getSelection(): string {
        return cleanSelection(term.getSelection());
      },
      refreshSize(): boolean {
        const done = claim(true);
        term.focus();
        return done;
      },
    };
    onApiRef.current?.(api);

    // Taille qui remplit cette fenêtre, sans l'appliquer.
    const measure = (): boolean => {
      if (host.clientWidth < 20 || host.clientHeight < 20) return false;
      const dims = fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return false;
      if (dims.cols < 2 || dims.rows < 2) return false;
      fitCols = dims.cols;
      fitRows = dims.rows;
      return true;
    };

    const applySize = (): void => {
      // Sans taille connue du serveur (session terminée), le terminal suit simplement la fenêtre.
      const cols = ptyCols || fitCols;
      const rows = ptyRows || fitRows;
      if (cols >= 2 && rows >= 2 && (term.cols !== cols || term.rows !== rows)) term.resize(cols, rows);
      const foreign = !owner && ptyCols > 0 && fitCols > 0 && (ptyCols !== fitCols || ptyRows !== fitRows);
      const key = foreign ? `${ptyCols}x${ptyRows}` : '';
      if (key === lastBorrowed || closed) return;
      lastBorrowed = key;
      setBorrowed(foreign ? { cols: ptyCols, rows: ptyRows } : null);
    };

    // Ce poste prend la main : le PTY adopte la taille de sa fenêtre, les autres postes s'y alignent.
    // force : renvoie la taille même inchangée, pour que l'application se redessine.
    const claim = (force = false): boolean => {
      if (!measure()) return false;
      if (force || fitCols !== ptyCols || fitRows !== ptyRows) {
        const msg: TermClientMessage = { type: 'resize', cols: fitCols, rows: fitRows };
        if (!send(current(), force ? { ...msg, force } : msg)) return false;
        ptyCols = fitCols;
        ptyRows = fitRows;
      }
      claimedCols = fitCols;
      claimedRows = fitRows;
      owner = true;
      applySize();
      return true;
    };
    const claimNow = (): void => {
      claim();
    };
    claimRef.current = () => {
      claim();
      term.focus();
    };

    // La fenêtre change de taille : le poste qui a la main garde le PTY ajusté, les autres seulement leur bandeau.
    const onHostResize = (): void => {
      if (owner) {
        claim();
      } else if (measure()) {
        applySize();
      }
    };

    const dataSub = term.onData(input);
    const selectionSub = term.onSelectionChange(() => {
      onSelectionRef.current?.(term.getSelection().trim() !== '');
    });

    const notice = (text: string): void => {
      term.write(`\r\n\x1b[31m[cerebro] ${text}\x1b[0m\r\n`);
    };
    const sendImage = (image: Blob): void => {
      uploadImage(sessionId, image).then(
        (path) => {
          input(`${path} `);
        },
        (err: unknown) => {
          notice(`image non envoyée : ${errorMessage(err, 'erreur')}`);
        },
      );
    };

    // Capture : intercepte le collage d'une image avant xterm, qui ne gère que le texte.
    const onPaste = (event: ClipboardEvent): void => {
      const image = clipboardImage(event.clipboardData);
      if (image) {
        event.preventDefault();
        event.stopPropagation();
        sendImage(image);
        return;
      }
      if (event.clipboardData?.getData('text/plain')) return;
      // Ni image ni texte exposés par l'événement : on interroge directement le presse-papiers.
      event.preventDefault();
      event.stopPropagation();
      const types = Array.from(event.clipboardData?.types ?? []).join(', ') || 'aucun';
      readClipboardImage().then(
        (blob) => {
          if (blob) sendImage(blob);
          else notice(`aucune image dans le presse-papiers (types : ${types})`);
        },
        (err: unknown) => {
          notice(`presse-papiers illisible (types : ${types}) : ${errorMessage(err, 'erreur')}`);
        },
      );
    };
    host.addEventListener('paste', onPaste, true);
    // Un clic ou le retour du focus dans ce terminal (fenêtre réactivée) : ce poste reprend la main.
    host.addEventListener('pointerdown', claimNow, true);
    host.addEventListener('focusin', claimNow);

    const ro = new ResizeObserver(() => {
      onHostResize();
    });
    ro.observe(host);

    link = openReconnectingSocket(wsUrl(`/ws/term/${sessionId}`), {
      onOpen: () => {
        reconnecting = false;
        // Ouvrir la session la prend en main ; une simple reconnexion ne la reprend pas à un autre poste.
        const first = !connected;
        connected = true;
        if (first || owner) claim();
        flushPending();
        term.focus();
      },
      onMessage: (raw) => {
        const msg = parseTermServerMessage(raw);
        if (!msg) return;
        if (msg.type === 'size') {
          ptyCols = msg.cols;
          ptyRows = msg.rows;
          owner = ptyCols === claimedCols && ptyRows === claimedRows;
          // Le poste qui a la main réajuste si sa fenêtre a bougé depuis sa demande (mise en page qui se stabilise).
          if (owner) {
            claim();
          } else {
            measure();
            applySize();
          }
        } else if (msg.type === 'snapshot') {
          term.reset();
          term.write(msg.data);
        } else if (msg.type === 'output') {
          term.write(msg.data);
        }
      },
      onClose: () => {
        reconnecting = true;
        publishLink();
      },
    });
    const firstFrame = requestAnimationFrame(() => {
      if (measure()) applySize();
      term.focus();
    });

    return () => {
      closed = true;
      cancelAnimationFrame(firstFrame);
      // Le rappel courant du parent, pas celui du montage : c'est l'intérêt de useLatest.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      onApiRef.current?.(null);
      dataSub.dispose();
      selectionSub.dispose();
      // eslint-disable-next-line react-hooks/exhaustive-deps
      onSelectionRef.current?.(false);
      host.removeEventListener('paste', onPaste, true);
      host.removeEventListener('pointerdown', claimNow, true);
      host.removeEventListener('focusin', claimNow);
      claimRef.current = () => undefined;
      ro.disconnect();
      link?.close();
      term.dispose();
    };
  }, [sessionId, onApiRef, onEscapeRef, onSelectionRef]);

  return (
    <>
      <div className="term-host" ref={hostRef} />
      {link.reconnecting ? (
        <div className="term-link" role="status">
          Terminal déconnecté — reconnexion…
          {link.pending > 0 ? ` · ${link.pending} caractère${link.pending > 1 ? 's' : ''} en attente d’envoi` : ''}
          {link.dropped ? ' · frappes au-delà de la limite ignorées' : ''}
        </div>
      ) : borrowed ? (
        <button
          type="button"
          className="term-link term-size"
          onClick={() => {
            claimRef.current();
          }}
        >
          Dimensions imposées par un autre écran ({borrowed.cols}×{borrowed.rows}) — cliquer ou taper pour les adapter à
          cette fenêtre
        </button>
      ) : null}
    </>
  );
}
