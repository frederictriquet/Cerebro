import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { DiscoveredSkill } from '../shared/types.ts';

const MAX_FRONTMATTER_READ_BYTES = 32 * 1024;
const MAX_SKILL_SUMMARY_LENGTH = 300;
const SAFE_SKILL_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export interface StoredSkillConfig {
  path: string;
}

export interface StoredSkillExtension {
  id: string;
  kind: 'skill';
  name: string;
  description: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}

export interface ResolvedSkillEntry {
  /** Safe directory name used when mounting under `skills/<slug>/`. */
  slug: string;
  /** Display name parsed from `SKILL.md` frontmatter (falls back to `slug`). */
  name: string;
  /** Description parsed from `SKILL.md` frontmatter. */
  description: string;
  /** Absolute path to the directory containing `SKILL.md`. */
  dirPath: string;
}

export interface SkillDirectoryInspection {
  exists: boolean;
  skills: ResolvedSkillEntry[];
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function clampSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_SKILL_SUMMARY_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_SKILL_SUMMARY_LENGTH - 1)}…`;
}

/** Parses `name` and `description` from a `SKILL.md` YAML frontmatter block (inline or multi-line scalars). */
export function parseSkillFrontmatter(markdown: string): { name: string | null; description: string } {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { name: null, description: '' };
  const closingIndex = normalized.indexOf('\n---', 4);
  if (closingIndex === -1) return { name: null, description: '' };
  const afterClosing = normalized[closingIndex + 4];
  if (afterClosing !== undefined && afterClosing !== '\n') return { name: null, description: '' };

  const lines = normalized.slice(4, closingIndex).split('\n');
  const fields: Record<string, string> = {};

  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const [, key, rawValue] = match;
    const indicator = rawValue.trim();

    if (/^[>|][+-]?$/.test(indicator) || indicator === '') {
      const literalBlock = indicator.startsWith('|');
      const blockLines: string[] = [];
      let baseIndent: number | null = null;
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (nextLine.trim() === '') {
          blockLines.push('');
          i++;
          continue;
        }
        const indent = /^(\s*)/.exec(nextLine)?.[1].length ?? 0;
        if (indent === 0) break;
        if (baseIndent === null) baseIndent = indent;
        blockLines.push(nextLine.slice(Math.min(indent, baseIndent)));
        i++;
      }
      fields[key] = blockLines.join(literalBlock ? '\n' : ' ').trim();
    } else {
      fields[key] = unquoteYamlScalar(rawValue);
    }
  }

  const rawName = fields.name?.trim() ?? '';
  const rawDescription = fields.description ?? '';
  return {
    name: rawName === '' ? null : rawName.slice(0, 80),
    description: clampSummary(rawDescription),
  };
}

function readBoundedPrefix(filePath: string): string | null {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.allocUnsafe(MAX_FRONTMATTER_READ_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function sanitizeSlug(candidate: string, fallback = 'skill'): string {
  if (SAFE_SKILL_SLUG.test(candidate)) return candidate;
  const cleaned = candidate
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .slice(0, 64);
  return SAFE_SKILL_SLUG.test(cleaned) ? cleaned : fallback;
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function readSkillAt(skillDir: string, preferredSlug: string): ResolvedSkillEntry | null {
  const skillFile = join(skillDir, 'SKILL.md');
  if (!isFile(skillFile)) return null;
  const content = readBoundedPrefix(skillFile);
  if (content === null) return null;
  const frontmatter = parseSkillFrontmatter(content);
  const slug = sanitizeSlug(preferredSlug, sanitizeSlug(frontmatter.name ?? 'skill'));
  return {
    slug,
    name: frontmatter.name ?? slug,
    description: frontmatter.description,
    dirPath: skillDir,
  };
}

/**
 * Inspects a skill extension directory on disk:
 * - if `<dirPath>/SKILL.md` exists, treats `dirPath` as a single skill;
 * - otherwise scans direct child folders `<dirPath>/<child>/SKILL.md` as a skill pack.
 */
export function inspectSkillDirectory(dirPath: string): SkillDirectoryInspection {
  if (!isDirectory(dirPath)) return { exists: false, skills: [] };

  const direct = readSkillAt(dirPath, basename(dirPath));
  if (direct !== null) {
    const slug = direct.name !== direct.slug && SAFE_SKILL_SLUG.test(direct.name) ? direct.name : direct.slug;
    return { exists: true, skills: [{ ...direct, slug }] };
  }

  let entries: string[];
  try {
    entries = readdirSync(dirPath).sort((a, b) => a.localeCompare(b, 'en'));
  } catch {
    return { exists: false, skills: [] };
  }

  const skills: ResolvedSkillEntry[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const childDir = join(dirPath, entry);
    if (!isDirectory(childDir)) continue;
    const parsed = readSkillAt(childDir, entry);
    if (parsed !== null) skills.push(parsed);
  }
  return { exists: true, skills };
}

export function toPublicDiscoveredSkills(entries: readonly ResolvedSkillEntry[]): DiscoveredSkill[] {
  return entries.map(({ name, description }) => ({ name, description }));
}

/** Expands `~/...` or absolute `/...` paths; rejects relative paths, `/` and the home root itself. */
export function expandSkillPath(rawPath: string, home = homedir()): string | null {
  const trimmed = rawPath.trim();
  if (trimmed === '' || trimmed.includes('\0') || trimmed.includes('\r') || trimmed.includes('\n')) return null;
  let resolved: string;
  if (trimmed.startsWith('~/')) {
    resolved = resolve(home, trimmed.slice(2));
  } else if (trimmed.startsWith('/')) {
    resolved = resolve(trimmed);
  } else {
    return null;
  }
  const normalizedHome = resolve(home);
  if (resolved === '/' || resolved === normalizedHome) return null;
  return resolved;
}

function isInsideOrEqual(targetPath: string, rootPath: string): boolean {
  const resolvedRoot = resolve(rootPath);
  return targetPath === resolvedRoot || targetPath.startsWith(`${resolvedRoot}/`);
}

/** Returns true when `resolvedPath` lies inside a global directory already auto-loaded by agent CLIs on every session. */
export function isGlobalAgentSkillDir(resolvedPath: string, home = homedir()): boolean {
  const globalDirs = [
    join(home, '.claude', 'skills'),
    join(home, '.codex', 'skills'),
    join(home, '.grok', 'skills'),
    join(home, '.gemini', 'config'),
    join(home, '.agents', 'skills'),
  ];
  return globalDirs.some((dir) => isInsideOrEqual(resolvedPath, dir));
}

function canonicalDirKey(dirPath: string): string {
  try {
    return realpathSync(dirPath);
  } catch {
    return resolve(dirPath);
  }
}

/** Ensures every active skill extension still points to an existing folder with at least one `SKILL.md`. */
export function assertValidSkillExtensions(extensions: readonly StoredSkillExtension[]): void {
  for (const ext of extensions) {
    const inspected = inspectSkillDirectory(ext.path);
    if (!inspected.exists) {
      throw new Error(`Le dossier de l'extension « ${ext.name} » est introuvable (${ext.path})`);
    }
    if (inspected.skills.length === 0) {
      throw new Error(`L'extension « ${ext.name} » ne contient aucun fichier SKILL.md (${ext.path})`);
    }
  }
}

/** Collects and deduplicates skills across active skill extensions, resolving slug collisions deterministically. */
export function collectSessionSkills(extensions: readonly StoredSkillExtension[]): ResolvedSkillEntry[] {
  const seenDirs = new Set<string>();
  const usedSlugs = new Set<string>();
  const out: ResolvedSkillEntry[] = [];

  for (const ext of extensions) {
    const inspected = inspectSkillDirectory(ext.path);
    if (!inspected.exists) continue;
    for (const skill of inspected.skills) {
      const canonical = canonicalDirKey(skill.dirPath);
      if (seenDirs.has(canonical)) continue;
      seenDirs.add(canonical);

      let slug = skill.slug;
      if (usedSlugs.has(slug)) {
        const prefixed = sanitizeSlug(`${ext.name}-${slug}`);
        slug = prefixed;
        let suffix = 2;
        while (usedSlugs.has(slug)) {
          slug = sanitizeSlug(`${prefixed.slice(0, 56)}-${suffix++}`);
        }
      }
      usedSlugs.add(slug);
      out.push({ ...skill, slug });
    }
  }

  return out;
}
