import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.ts';
import { gitSync } from './git.ts';
import type { Compatibility, VersionInfo } from '../shared/machine.ts';

/*
 * Version de l'application, en SemVer (package.json), complétée du commit git court en métadonnée de build.
 * MAJEURE : changement incompatible du contrat entre machines (échange /api/peer/sync, routes relayées
 * par /m/<id>/…, formats lus par l'UI d'une autre machine) ; MINEURE : fonctionnalité ; CORRECTIVE : correctif.
 * Règle : même version majeure = compatible (en 0.y.z, même 0.y, chaque mineure pouvant tout casser).
 */

// Grammaire officielle (semver.org), sans métadonnée de build : le commit en tient lieu.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export function isSemver(version: string): boolean {
  return SEMVER.test(version);
}

/** Partie de la version qui doit coïncider entre deux machines compatibles. */
function compatibilityKey(version: string): string | null {
  const match = SEMVER.exec(version);
  if (match === null) return null;
  const [, major, minor] = match;
  return major === '0' ? `0.${minor}` : major!;
}

function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && isSemver(parsed.version)) return parsed.version;
    console.error(`[version] version de package.json non SemVer : ${String(parsed.version)}`);
  } catch {
    // Repli ci-dessous.
  }
  return '0.0.0';
}

function gitCommit(): string | null {
  if (process.env.CEREBRO_COMMIT !== undefined) return process.env.CEREBRO_COMMIT || null;
  try {
    const commit = gitSync(ROOT, ['rev-parse', '--short', 'HEAD'], { timeout: 2_000 }).trim();
    return commit === '' ? null : commit;
  } catch {
    // Installation hors dépôt git.
    return null;
  }
}

export const VERSION_INFO: VersionInfo = { version: packageVersion(), commit: gitCommit() };

export function versionLabel(info: VersionInfo): string {
  return info.commit === null ? info.version : `${info.version}+${info.commit}`;
}

/**
 * null : champ absent ou malformé, ou instance antérieure au SemVer (elle envoie encore un `protocol`
 * entier) : traitée comme inconnue, donc acceptée, comme elle-même accepte une instance sans protocole.
 */
export function versionInfoFrom(value: unknown): VersionInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.version !== 'string' || !isSemver(record.version) || 'protocol' in record) return null;
  if (record.commit !== undefined && record.commit !== null && typeof record.commit !== 'string') return null;
  return { version: record.version, commit: record.commit ?? null };
}

export function compatibility(remote: VersionInfo | null, local: VersionInfo = VERSION_INFO): Compatibility {
  if (remote === null) return 'unknown';
  if (compatibilityKey(remote.version) !== compatibilityKey(local.version)) return 'incompatible';
  const sameCommit = remote.commit === null || local.commit === null || remote.commit === local.commit;
  return remote.version === local.version && sameCommit ? 'same' : 'compatible';
}
