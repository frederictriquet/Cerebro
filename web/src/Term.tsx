import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import { clipboardImage, readClipboardImage, uploadImage, wsUrl } from './api.ts';
import { parseTermServerMessage, type TermClientMessage } from './types.ts';

const FONT = 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace';

export interface TermApi {
  sendInput: (data: string) => boolean;
  sendArrow: (direction: 'up' | 'down') => boolean;
  focus: () => void;
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
}: {
  sessionId: string;
  onApi?: (api: TermApi | null) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onApiRef = useRef(onApi);
  onApiRef.current = onApi;

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
    // xterm traduit Ctrl+V en ^V et annule l'événement : le navigateur ne colle alors jamais.
    // On le lui laisse, pour que l'événement paste (texte ou image) ait lieu.
    term.attachCustomKeyEventHandler((event) =>
      !(event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'KeyV'));
    term.open(host);
    term.focus();

    const socketRef: { current: WebSocket | null } = { current: null };
    let closed = false;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let lastCols = 0;
    let lastRows = 0;

    const api: TermApi = {
      sendInput(data: string): boolean {
        return send(socketRef.current, { type: 'input', data });
      },
      sendArrow(direction: 'up' | 'down'): boolean {
        const application = term.modes.applicationCursorKeysMode;
        const data = direction === 'up'
          ? (application ? '\x1bOA' : '\x1b[A')
          : (application ? '\x1bOB' : '\x1b[B');
        return send(socketRef.current, { type: 'input', data });
      },
      focus(): void {
        term.focus();
      },
    };
    onApiRef.current?.(api);

    const sendResize = (): void => {
      const cols = term.cols;
      const rows = term.rows;
      if (cols < 2 || rows < 2) return;
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      send(socketRef.current, { type: 'resize', cols, rows });
    };

    const doFit = (): void => {
      if (host.clientWidth < 20 || host.clientHeight < 20) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      sendResize();
    };

    const dataSub = term.onData((data) => {
      send(socketRef.current, { type: 'input', data });
    });

    const notice = (text: string): void => {
      term.write(`\r\n\x1b[31m[cerebro] ${text}\x1b[0m\r\n`);
    };
    const sendImage = (image: Blob): void => {
      uploadImage(sessionId, image).then(
        (path) => {
          send(socketRef.current, { type: 'input', data: `${path} ` });
        },
        (err: unknown) => {
          notice(`image non envoyée : ${err instanceof Error ? err.message : 'erreur'}`);
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
          notice(`presse-papiers illisible (types : ${types}) : ${err instanceof Error ? err.message : 'erreur'}`);
        },
      );
    };
    host.addEventListener('paste', onPaste, true);

    const ro = new ResizeObserver(() => {
      doFit();
    });
    ro.observe(host);

    const connect = (): void => {
      if (closed) return;
      const socket = new WebSocket(wsUrl(`/ws/term/${sessionId}`));
      socketRef.current = socket;
      socket.addEventListener('open', () => {
        retry = 0;
        lastCols = 0;
        lastRows = 0;
        doFit();
        term.focus();
      });
      socket.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') return;
        let raw: unknown;
        try {
          raw = JSON.parse(ev.data) as unknown;
        } catch {
          return;
        }
        const msg = parseTermServerMessage(raw);
        if (!msg) return;
        if (msg.type === 'snapshot') {
          term.reset();
          term.write(msg.data);
        } else if (msg.type === 'output') {
          term.write(msg.data);
        }
      });
      socket.addEventListener('close', () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (closed) return;
        const delay = Math.min(8_000, 400 * 2 ** retry);
        retry += 1;
        retryTimer = setTimeout(connect, delay);
      });
      socket.addEventListener('error', () => {
        socket.close();
      });
    };

    connect();
    requestAnimationFrame(() => {
      doFit();
      term.focus();
    });

    return () => {
      closed = true;
      onApiRef.current?.(null);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      dataSub.dispose();
      host.removeEventListener('paste', onPaste, true);
      ro.disconnect();
      socketRef.current?.close();
      socketRef.current = null;
      term.dispose();
    };
  }, [sessionId]);

  return <div className="term-host" ref={hostRef} />;
}
