import { closeSync, createReadStream, openSync, readSync, statSync } from 'node:fs';

/**
 * Records of a JSONL text, last line first. Lines that do not parse (blank, truncated, plain progress
 * text) are skipped; with `hint`, lines that do not contain it are skipped without being parsed.
 */
export function* jsonlFromEnd(text: string, hint?: string): Generator<unknown> {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (hint !== undefined && !lines[i]!.includes(hint)) continue;
    let record: unknown;
    try {
      record = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    yield record;
  }
}

/** Records of the last `maxBytes` of a JSONL file, last first; the first line, possibly cut, is skipped if it no longer parses. */
export function readJsonlTail(path: string, maxBytes: number, hint?: string): Generator<unknown> {
  const fd = openSync(path, 'r');
  let text: string;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    text = buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
  return jsonlFromEnd(text, hint);
}

/**
 * Streams the records of a JSONL file between bytes `start` (included) and `end` (excluded), in order;
 * malformed records are skipped. A last record without its newline is still passed to `accept`, but the
 * returned offset stops just past the last newline, so that record is read again once the file grows.
 * `consumed` receives, in order, the bytes the returned offset moves past.
 */
export async function iterateJsonl(path: string, start: number, end: number, accept: (record: unknown) => void, consumed?: (bytes: Buffer) => void): Promise<number> {
  let offset = start;
  if (end <= start) return offset;
  const stream = createReadStream(path, { start, end: end - 1 });
  let tail = Buffer.alloc(0);
  const parse = (line: Buffer): void => {
    let record: unknown;
    try {
      record = JSON.parse(line.toString('utf8'));
    } catch {
      return;
    }
    accept(record);
  };
  try {
    for await (const chunk of stream) {
      tail = Buffer.concat([tail, chunk as Buffer]);
      let from = 0;
      let newline: number;
      while ((newline = tail.indexOf(10, from)) !== -1) {
        parse(tail.subarray(from, newline));
        offset += newline - from + 1;
        from = newline + 1;
      }
      if (from > 0) consumed?.(tail.subarray(0, from));
      tail = Buffer.from(tail.subarray(from));
    }
    if (tail.length > 0) parse(tail);
  } finally {
    stream.destroy();
  }
  return offset;
}
