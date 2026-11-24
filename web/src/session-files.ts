// Pure rules of the « Fichiers » panel of the desktop session view.
// [SPEC: Interface › Vue session desktop, panneau « Fichiers »]

export const FILE_RESULTS_MAX = 200;
export const EXCERPT_MAX = 200;

export type FileRead =
  { path: string; version: string; content: string } | { path: string; version: string; unchanged: true };

export function parseFileList(value: unknown): { files: string[]; truncated: boolean } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { files, truncated } = value as Record<string, unknown>;
  if (!Array.isArray(files) || !files.every((file) => typeof file === 'string')) return null;
  return { files, truncated: truncated === true };
}

export function parseFileRead(value: unknown): FileRead | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.path !== 'string' || typeof v.version !== 'string') return null;
  if (v.unchanged === true) return { path: v.path, version: v.version, unchanged: true };
  if (typeof v.content !== 'string') return null;
  return { path: v.path, version: v.version, content: v.content };
}

/** Files shown rendered, with their source line numbers. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/** Paths containing `query` (case-insensitive), at most FILE_RESULTS_MAX. */
export function filterFiles(files: string[], query: string, limit = FILE_RESULTS_MAX): string[] {
  const needle = query.trim().toLowerCase();
  const matches = needle === '' ? files : files.filter((file) => file.toLowerCase().includes(needle));
  return matches.slice(0, limit);
}

/** Lines of a file as shown, without the empty line after a final newline. */
export function fileLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

/** `path:L12-L14 « excerpt »`, the excerpt on one line, whitespace collapsed, cut at EXCERPT_MAX characters. */
export function citation(path: string, start: number, end: number, text: string): string {
  const [first, last] = start <= end ? [start, end] : [end, start];
  const lines = first === last ? `L${first}` : `L${first}-L${last}`;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const chars = [...collapsed];
  const excerpt = chars.length > EXCERPT_MAX ? `${chars.slice(0, EXCERPT_MAX).join('').trimEnd()}…` : collapsed;
  return excerpt === '' ? `${path}:${lines}` : `${path}:${lines} « ${excerpt} »`;
}

/** Appends `addition` to a message field, separated by one space when the field already has text. */
export function appendToMessage(current: string, addition: string): string {
  return current.trim() === '' ? addition : `${current.trimEnd()} ${addition}`;
}
