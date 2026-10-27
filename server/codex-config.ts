import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TomlScalar = string | number | boolean;

/** Codex's configuration directory, resolved on each call so tests can redirect it. */
export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

/**
 * Codex session rollouts, `sessions/YYYY/MM/DD/*.jsonl`, newest day first. With `limit`, listing stops
 * after the day that reaches it. A resumed session keeps writing into the directory of the day it started.
 */
export async function listCodexRollouts(root = join(codexHome(), 'sessions'), limit = Infinity): Promise<string[]> {
  const entries = async (dir: string): Promise<string[]> => readdir(dir).catch(() => []);
  const dated = async (dir: string): Promise<string[]> => (await entries(dir)).filter((name) => /^\d+$/.test(name)).sort().reverse();
  const found: string[] = [];
  for (const year of await dated(root)) {
    for (const month of await dated(join(root, year))) {
      for (const day of await dated(join(root, year, month))) {
        const dir = join(root, year, month, day);
        for (const name of await entries(dir)) if (name.endsWith('.jsonl')) found.push(join(dir, name));
        if (found.length >= limit) return found;
      }
    }
  }
  return found;
}

const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
const BARE_KEY = /[A-Za-z0-9_-]/;

class TomlError extends Error {}

/**
 * Top-level key/value pairs of a TOML document, up to its first table header. Only scalar values
 * (strings, booleans, numbers) are kept; arrays, inline tables and dates are parsed and skipped.
 * Dotted keys are stored under their dotted path. A malformed line is skipped, not fatal.
 */
export function parseTomlTopLevel(text: string): Map<string, TomlScalar> {
  const values = new Map<string, TomlScalar>();
  let pos = 0;
  const peek = (offset = 0): string => text[pos + offset] ?? '';
  const startsWith = (token: string): boolean => text.startsWith(token, pos);
  const fail = (): never => { throw new TomlError(); };
  const skipBlank = (): void => { while (peek() === ' ' || peek() === '\t') pos++; };
  const skipComment = (): void => { if (peek() === '#') while (pos < text.length && peek() !== '\n') pos++; };
  // Whitespace, newlines and comments, as allowed between array elements and between statements.
  const skipSpace = (): void => {
    for (;;) {
      skipBlank();
      skipComment();
      if (peek() === '\n' || startsWith('\r\n')) pos += peek() === '\n' ? 1 : 2;
      else return;
    }
  };
  const escape = (): string => {
    const code = peek(1);
    if (code === 'u' || code === 'U') {
      const hex = text.slice(pos + 2, pos + (code === 'u' ? 6 : 10));
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== (code === 'u' ? 4 : 8)) fail();
      pos += 2 + hex.length;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    if (code === 'x' && /^[0-9a-fA-F]{2}$/.test(text.slice(pos + 2, pos + 4))) {
      pos += 4;
      return String.fromCodePoint(parseInt(text.slice(pos - 2, pos), 16));
    }
    const char = ESCAPES[code];
    if (char === undefined) fail();
    pos += 2;
    return char!;
  };
  const singleLine = (quote: string): string => {
    pos++;
    let value = '';
    while (peek() !== quote) {
      if (pos >= text.length || peek() === '\n') fail();
      if (quote === '"' && peek() === '\\') value += escape();
      else value += text[pos++];
    }
    pos++;
    return value;
  };
  const multiLine = (quote: string): string => {
    const delimiter = quote.repeat(3);
    pos += 3;
    if (peek() === '\n') pos++;
    else if (startsWith('\r\n')) pos += 2;
    let value = '';
    for (;;) {
      if (pos >= text.length) fail();
      if (startsWith(delimiter)) {
        // Up to two quotes may directly precede the closing delimiter: `""""` ends with one quote in the value.
        let extra = 0;
        while (extra < 2 && text[pos + 3 + extra] === quote) extra++;
        value += quote.repeat(extra);
        pos += 3 + extra;
        return value;
      }
      if (quote === '"' && peek() === '\\') {
        // Line-ending backslash: trims the newline and the whitespace that follows.
        const rest = /^\\[ \t]*\r?\n[\s]*/.exec(text.slice(pos));
        if (rest !== null) pos += rest[0].length;
        else value += escape();
      } else {
        value += text[pos++];
      }
    }
  };
  const parseKey = (): string => {
    const parts: string[] = [];
    for (;;) {
      skipBlank();
      if (peek() === '"' || peek() === "'") {
        parts.push(singleLine(peek()));
      } else {
        const start = pos;
        while (BARE_KEY.test(peek())) pos++;
        if (pos === start) fail();
        parts.push(text.slice(start, pos));
      }
      skipBlank();
      if (peek() !== '.') return parts.join('.');
      pos++;
    }
  };
  // Returns undefined for values that are not kept: arrays, inline tables, dates and times.
  const parseValue = (): TomlScalar | undefined => {
    if (startsWith('"""') || startsWith("'''")) return multiLine(peek());
    if (peek() === '"' || peek() === "'") return singleLine(peek());
    if (peek() === '[') {
      pos++;
      for (;;) {
        skipSpace();
        if (peek() === ']') break;
        parseValue();
        skipSpace();
        if (peek() === ',') pos++;
        else if (peek() !== ']') fail();
      }
      pos++;
      return undefined;
    }
    if (peek() === '{') {
      pos++;
      skipBlank();
      while (peek() !== '}') {
        parseKey();
        if (peek() !== '=') fail();
        pos++;
        skipBlank();
        parseValue();
        skipBlank();
        if (peek() === ',') { pos++; skipBlank(); } else if (peek() !== '}') fail();
      }
      pos++;
      return undefined;
    }
    const start = pos;
    // Bare values run to a separator; a space is kept only inside a date-time (`1979-05-27 07:32:00`).
    while (pos < text.length && !/[\s,\]}#]/.test(peek())) pos++;
    if (peek() === ' ' && /^\d{4}-\d{2}-\d{2}$/.test(text.slice(start, pos)) && /\d/.test(peek(1))) {
      pos++;
      while (pos < text.length && !/[\s,\]}#]/.test(peek())) pos++;
    }
    const raw = text.slice(start, pos);
    if (raw === 'true' || raw === 'false') return raw === 'true';
    if (/^[+-]?(inf|nan)$/.test(raw)) return raw.endsWith('nan') ? NaN : raw.startsWith('-') ? -Infinity : Infinity;
    if (/^0x[0-9a-fA-F_]+$|^0o[0-7_]+$|^0b[01_]+$/.test(raw)) return Number(raw.replaceAll('_', ''));
    if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d[\d_]*)?$/.test(raw)) return Number(raw.replaceAll('_', ''));
    if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(raw)) return undefined;
    return fail();
  };

  for (;;) {
    skipSpace();
    if (pos >= text.length || peek() === '[') return values;
    const lineStart = pos;
    try {
      const name = parseKey();
      if (peek() !== '=') fail();
      pos++;
      skipBlank();
      const parsed = parseValue();
      skipBlank();
      skipComment();
      if (pos < text.length && peek() !== '\n' && !startsWith('\r\n')) fail();
      if (parsed !== undefined) values.set(name, parsed);
    } catch (error) {
      if (!(error instanceof TomlError)) throw error;
      // Resume on the line after the one the malformed statement starts on.
      const next = text.indexOf('\n', lineStart);
      if (next === -1) return values;
      pos = next + 1;
    }
  }
}

/** Top-level scalar settings of the user's Codex `config.toml`; empty when the file is missing or unreadable. */
export function readCodexConfig(): Map<string, TomlScalar> {
  let text: string;
  try {
    text = readFileSync(join(codexHome(), 'config.toml'), 'utf8');
  } catch {
    return new Map();
  }
  return parseTomlTopLevel(text);
}

/** A top-level string setting of the user's Codex config, or null when absent or not a string. */
export function readCodexString(name: string): string | null {
  const value = readCodexConfig().get(name);
  return typeof value === 'string' ? value : null;
}
