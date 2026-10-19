import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.ts';

/*
 * Version de l'application (package.json + commit git court) et version du protocole entre instances.
 * PROTOCOL_VERSION est à incrémenter à chaque changement incompatible du contrat entre machines :
 * échange /api/peer/sync, routes relayées par /m/<id>/… et formats lus par l'UI d'une autre machine.
 * Règle : même protocole = compatible, quelle que soit la version de l'application.
 */
export const PROTOCOL_VERSION = 2;

export interface VersionInfo {
  version: string;
  commit: string | null;
  protocol: number;
}

/** same : même version ; compatible : version différente, même protocole ; unknown : instance trop ancienne ou injoignable. */
export type Compatibility = 'same' | 'compatible' | 'incompatible' | 'unknown';

function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version;
  } catch {
    // Repli ci-dessous.
  }
  return '0.0.0';
}

function gitCommit(): string | null {
  if (process.env.CEREBRO_COMMIT !== undefined) return process.env.CEREBRO_COMMIT || null;
  try {
    const commit = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    return commit === '' ? null : commit;
  } catch {
    // Installation hors dépôt git.
    return null;
  }
}

export const VERSION_INFO: VersionInfo = { version: packageVersion(), commit: gitCommit(), protocol: PROTOCOL_VERSION };

export function versionLabel(info: VersionInfo): string {
  return info.commit === null ? info.version : `${info.version}+${info.commit}`;
}

/** null : champ absent (instance antérieure à l'exposition des versions) ou malformé. */
export function versionInfoFrom(value: unknown): VersionInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.version !== 'string' || !Number.isSafeInteger(record.protocol)) return null;
  if (record.commit !== undefined && record.commit !== null && typeof record.commit !== 'string') return null;
  return { version: record.version, commit: record.commit ?? null, protocol: record.protocol as number };
}

export function compatibility(remote: VersionInfo | null, local: VersionInfo = VERSION_INFO): Compatibility {
  if (remote === null) return 'unknown';
  if (remote.protocol !== local.protocol) return 'incompatible';
  const sameCommit = remote.commit === null || local.commit === null || remote.commit === local.commit;
  return remote.version === local.version && sameCommit ? 'same' : 'compatible';
}
