import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Agent } from '../shared/types.ts';
import { tomlKey } from './mcp.ts';
import { errorMessage, isRecord } from './util.ts';

function claudeStateFile(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  return configDir ? join(configDir, '.claude.json') : join(homedir(), '.claude.json');
}

function grokTrustedFoldersFile(): string {
  const grokHome = process.env.GROK_HOME ?? join(homedir(), '.grok');
  return join(grokHome, 'trusted_folders.toml');
}

function writeAtomic(filePath: string, content: string, mode: number): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmpPath, content, { mode });
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Temp file never created or already moved.
    }
    throw error;
  }
}

function readExistingText(filePath: string): { text: string | null; mode: number } {
  try {
    const text = readFileSync(filePath, 'utf8');
    const mode = statSync(filePath).mode & 0o777;
    return { text, mode: mode === 0 ? 0o600 : mode };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, mode: 0o600 };
    throw error;
  }
}

/**
 * Resolves every path variant an agent CLI might check for workspace trust: `cwd`, the Git/worktree `root` when the
 * project points to a subdirectory (Grok checks `projectRoot` rather than `cwd`), and their `realpath` targets.
 */
export function resolveTrustedPaths(cwd: string, root?: string | null): string[] {
  const paths = new Set<string>();
  for (const candidate of [cwd, ...(root ? [root] : [])]) {
    const normalized = resolve(candidate);
    paths.add(normalized);
    try {
      paths.add(realpathSync(normalized));
    } catch {
      // Missing path or broken link: keep the normalized path.
    }
  }
  return [...paths];
}

export function trustClaudeFolders(paths: readonly string[], filePath = claudeStateFile()): void {
  if (paths.length === 0) return;
  try {
    const { text, mode } = readExistingText(filePath);
    let data: Record<string, unknown> = {};
    if (text !== null && text.trim() !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        console.warn(`[trust-folders] ${filePath} contient du JSON invalide : fichier laissé intact.`);
        return;
      }
      if (!isRecord(parsed)) {
        console.warn(`[trust-folders] ${filePath} n'est pas un objet JSON : fichier laissé intact.`);
        return;
      }
      data = parsed;
    }
    if ('projects' in data && data.projects !== undefined && !isRecord(data.projects)) {
      console.warn(`[trust-folders] champ projects inattendu dans ${filePath} : fichier laissé intact.`);
      return;
    }
    const projects = isRecord(data.projects) ? data.projects : {};
    if (paths.every((dir) => isRecord(projects[dir]) && projects[dir].hasTrustDialogAccepted === true)) return;

    const nextProjects: Record<string, unknown> = { ...projects };
    for (const dir of paths) {
      const current = isRecord(nextProjects[dir]) ? nextProjects[dir] : {};
      nextProjects[dir] = { ...current, hasTrustDialogAccepted: true };
    }
    writeAtomic(filePath, `${JSON.stringify({ ...data, projects: nextProjects }, null, 2)}\n`, mode);
  } catch (error) {
    console.warn(`[trust-folders] Impossible de mettre à jour ${filePath} : ${errorMessage(error)}`);
  }
}

function decodeTomlBasicString(quoted: string): string | null {
  try {
    const jsonCompatible = quoted.replace(/\\(?:U([0-9a-fA-F]{8})|e)/g, (match, hex: string | undefined) => {
      if (hex === undefined) return '\\u001b';
      const codePoint = Number.parseInt(hex, 16);
      return JSON.stringify(String.fromCodePoint(codePoint)).slice(1, -1);
    });
    const parsed: unknown = JSON.parse(jsonCompatible);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function parseFoldersTableHeader(line: string): string | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('[folders.')) return null;
  const rest = trimmed.slice('[folders.'.length).trimStart();
  if (rest.startsWith('"')) {
    let i = 1;
    while (i < rest.length) {
      if (rest[i] === '\\') {
        i += 2;
        continue;
      }
      if (rest[i] === '"') {
        if (!/^\s*\]\s*(?:#.*)?$/.test(rest.slice(i + 1))) return null;
        return decodeTomlBasicString(rest.slice(0, i + 1));
      }
      i++;
    }
    return null;
  }
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    if (end === -1 || !/^\s*\]\s*(?:#.*)?$/.test(rest.slice(end + 1))) return null;
    return rest.slice(1, end);
  }
  const bare = /^([A-Za-z0-9_-]+)\s*\]\s*(?:#.*)?$/.exec(rest);
  return bare ? (bare[1] ?? null) : null;
}

interface TomlSection {
  folderPath: string | null;
  lines: string[];
}

function splitTomlSections(text: string): TomlSection[] {
  const sections: TomlSection[] = [];
  let current: TomlSection = { folderPath: null, lines: [] };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      if (current.folderPath !== null || current.lines.some((l) => l.trim() !== '')) sections.push(current);
      current = { folderPath: parseFoldersTableHeader(line), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.folderPath !== null || current.lines.some((l) => l.trim() !== '')) sections.push(current);
  return sections;
}

function isSectionTrusted(lines: readonly string[]): boolean {
  let trusted: boolean | null = null;
  for (let i = 1; i < lines.length; i++) {
    const match = /^\s*trusted\s*=\s*(true|false)\s*(?:#.*)?$/.exec(lines[i] ?? '');
    if (match) trusted = match[1] === 'true';
  }
  return trusted === true;
}

function formatGrokFolderLines(dir: string, decidedAt: number): string[] {
  return [`[folders.${tomlKey(dir)}]`, 'trusted = true', `decided_at = ${decidedAt}`];
}

export function trustGrokFolders(
  paths: readonly string[],
  filePath = grokTrustedFoldersFile(),
  decidedAt = Math.floor(Date.now() / 1000),
): void {
  if (paths.length === 0) return;
  try {
    const { text, mode } = readExistingText(filePath);
    const sections = text === null || text.trim() === '' ? [] : splitTomlSections(text);
    const targetSet = new Set(paths);
    const seen = new Set<string>();
    let changed = false;
    const nextSections: TomlSection[] = [];

    for (const section of sections) {
      const dir = section.folderPath;
      if (dir !== null && targetSet.has(dir)) {
        if (seen.has(dir)) {
          changed = true;
          continue;
        }
        seen.add(dir);
        if (isSectionTrusted(section.lines)) {
          nextSections.push(section);
        } else {
          changed = true;
          nextSections.push({ folderPath: dir, lines: formatGrokFolderLines(dir, decidedAt) });
        }
      } else {
        nextSections.push(section);
      }
    }

    for (const dir of paths) {
      if (seen.has(dir)) continue;
      changed = true;
      nextSections.push({ folderPath: dir, lines: formatGrokFolderLines(dir, decidedAt) });
    }

    if (!changed) return;

    const rendered = nextSections
      .map((section) => {
        const trimmed = [...section.lines];
        while (trimmed.length > 0 && trimmed[trimmed.length - 1]?.trim() === '') trimmed.pop();
        return trimmed.join('\n');
      })
      .filter((block) => block !== '')
      .join('\n\n');
    writeAtomic(filePath, `${rendered}\n`, mode);
  } catch (error) {
    console.warn(`[trust-folders] Impossible de mettre à jour ${filePath} : ${errorMessage(error)}`);
  }
}

/**
 * Persists folder trust for agents without a session-scoped CLI flag (`claude`, `grok`) and returns the resolved
 * workspace paths (`cwd`, worktree root and `realpath` targets) for CLI-configured agents (`codex`, `gemini`).
 */
export function trustSessionFolders(agent: Agent, cwd: string, root?: string | null): string[] {
  const paths = resolveTrustedPaths(cwd, root);
  if (agent === 'claude') trustClaudeFolders(paths);
  else if (agent === 'grok') trustGrokFolders(paths);
  return paths;
}
