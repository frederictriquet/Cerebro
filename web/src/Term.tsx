import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import { wsUrl } from './api.ts';
import { parseTermServerMessage, type TermClientMessage } from './types.ts';

const FONT = 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace';

function send(ws: WebSocket | null, msg: TermClientMessage): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

export function Term({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

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
    term.open(host);
    term.focus();

    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let lastCols = 0;
    let lastRows = 0;

    const sendResize = (): void => {
      const cols = term.cols;
      const rows = term.rows;
      if (cols < 2 || rows < 2) return;
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      send(ws, { type: 'resize', cols, rows });
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
      send(ws, { type: 'input', data });
    });

    const ro = new ResizeObserver(() => {
      doFit();
    });
    ro.observe(host);

    const connect = (): void => {
      if (closed) return;
      const socket = new WebSocket(wsUrl(`/ws/term/${sessionId}`));
      ws = socket;
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
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      dataSub.dispose();
      ro.disconnect();
      ws?.close();
      term.dispose();
    };
  }, [sessionId]);

  return <div className="term-host" ref={hostRef} />;
}
