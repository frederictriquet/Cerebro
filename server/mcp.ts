import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '../shared/types.ts';
import type { StoredExtension, StoredMcpExtension, StoredSkillExtension } from './db.ts';
import { assertValidSkillExtensions, collectSessionSkills, type ResolvedSkillEntry } from './skills.ts';

export interface PreparedExtensions {
  /** Arguments prepended to the agent CLI invocation. */
  args: string[];
  /** Environment variables injected into the session PTY (never exposed in `ps`). */
  env: Record<string, string>;
  /** Additional workspace directories marked trusted for `agy`. */
  trustedDirs: string[];
}

const EMPTY_PREPARED: PreparedExtensions = { args: [], env: {}, trustedDirs: [] };

export function sessionExtensionsDir(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}.ext`);
}

function defaultGrokHome(): string {
  return process.env.GROK_HOME ?? join(homedir(), '.grok');
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

/** Valid TOML basic string (UTF-8 sanitized, standard escapes). */
export function tomlString(value: string): string {
  return JSON.stringify(Buffer.from(value, 'utf8').toString('utf8'));
}

export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

function safeEntries(dirPath: string): string[] {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

function symlinkSkillsInto(
  skillsDir: string,
  baseSkillsDir: string | null,
  skills: readonly ResolvedSkillEntry[],
): void {
  mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  if (baseSkillsDir !== null) {
    for (const existingName of safeEntries(baseSkillsDir)) {
      symlinkSync(join(baseSkillsDir, existingName), join(skillsDir, existingName));
    }
  }
  for (const skill of skills) {
    const linkPath = join(skillsDir, skill.slug);
    try {
      unlinkSync(linkPath);
    } catch {
      // No pre-existing link with the same slug.
    }
    symlinkSync(skill.dirPath, linkPath, 'dir');
  }
}

function prepareClaudeExtensions(
  mcpExtensions: readonly StoredMcpExtension[],
  skills: readonly ResolvedSkillEntry[],
  extDir: string,
): PreparedExtensions {
  mkdirSync(extDir, { recursive: true, mode: 0o700 });
  const args: string[] = [];

  if (mcpExtensions.length > 0) {
    const mcpServers: Record<string, object> = {};
    for (const ext of mcpExtensions) {
      if (ext.transport.type === 'http') {
        const hasHeaders = Object.keys(ext.transport.headers).length > 0;
        mcpServers[ext.name] = {
          type: 'http',
          url: ext.transport.url,
          ...(hasHeaders ? { headers: ext.transport.headers } : {}),
        };
      } else {
        const hasArgs = ext.transport.args.length > 0;
        const hasEnv = Object.keys(ext.transport.env).length > 0;
        mcpServers[ext.name] = {
          type: 'stdio',
          command: ext.transport.command,
          ...(hasArgs ? { args: ext.transport.args } : {}),
          ...(hasEnv ? { env: ext.transport.env } : {}),
        };
      }
    }
    const configPath = join(extDir, 'claude-mcp.json');
    writeFileSync(configPath, `${JSON.stringify({ mcpServers }, null, 2)}\n`, { mode: 0o600 });
    args.push('--mcp-config', configPath);
  }

  if (skills.length > 0) {
    // `--plugin-dir` loads session-scoped skills and explicitly follows symlinks pointing outside the plugin directory.
    const pluginDir = join(extDir, 'claude-plugin');
    const manifestDir = join(pluginDir, '.claude-plugin');
    mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(manifestDir, 'plugin.json'),
      `${JSON.stringify({ name: 'cerebro', version: '1.0.0', description: 'Skills de session Cerebro' }, null, 2)}\n`,
      { mode: 0o600 },
    );
    symlinkSkillsInto(join(pluginDir, 'skills'), null, skills);
    args.push('--plugin-dir', pluginDir);
  }

  return { args, env: {}, trustedDirs: [] };
}

function isCodexExcludedHomeEntry(name: string): boolean {
  return (
    name === 'skills' ||
    name === 'app-server-control' ||
    name === 'app-server-daemon' ||
    name === 'tmp' ||
    name === '.tmp' ||
    name === '.sqlite-maintenance.lock' ||
    name.endsWith('.sqlite') ||
    name.endsWith('.sqlite-wal') ||
    name.endsWith('.sqlite-shm')
  );
}

function prepareCodexExtensions(
  mcpExtensions: readonly StoredMcpExtension[],
  skills: readonly ResolvedSkillEntry[],
  extDir: string,
  baseCodexHome: string,
): PreparedExtensions {
  const args: string[] = [];
  const env: Record<string, string> = {};

  if (skills.length > 0) {
    const codexHomeDir = join(extDir, 'codex-home');
    mkdirSync(codexHomeDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(baseCodexHome, 'sessions'), { recursive: true, mode: 0o700 });

    for (const name of safeEntries(baseCodexHome)) {
      if (isCodexExcludedHomeEntry(name)) continue;
      symlinkSync(join(baseCodexHome, name), join(codexHomeDir, name));
    }
    symlinkSkillsInto(join(codexHomeDir, 'skills'), join(baseCodexHome, 'skills'), skills);

    // Run in-process so no background daemon outlives `codexHomeDir`, while keeping SQLite state and logs in `~/.codex`.
    args.push(
      '--no-daemon',
      '-c',
      `sqlite_home=${tomlString(baseCodexHome)}`,
      '-c',
      `log_dir=${tomlString(baseCodexHome)}`,
    );
    env.CODEX_HOME = codexHomeDir;
  }

  let headerIndex = 0;
  for (const ext of mcpExtensions) {
    const key = tomlKey(ext.name);
    if (ext.transport.type === 'http') {
      const fields = [`url=${tomlString(ext.transport.url)}`];
      const headerEntries = Object.entries(ext.transport.headers);
      if (headerEntries.length > 0) {
        // Pass HTTP auth header values via PTY environment (0600 holder config) instead of CLI args.
        const pairs = headerEntries.map(([headerName, headerValue]) => {
          const envVar = `CEREBRO_MCP_HDR_${headerIndex++}`;
          env[envVar] = headerValue;
          return `${tomlKey(headerName)}=${tomlString(envVar)}`;
        });
        fields.push(`env_http_headers={${pairs.join(',')}}`);
      }
      args.push('-c', `mcp_servers.${key}={${fields.join(',')}}`);
    } else {
      const fields = [`command=${tomlString(ext.transport.command)}`];
      if (ext.transport.args.length > 0) {
        fields.push(`args=[${ext.transport.args.map(tomlString).join(',')}]`);
      }
      const envEntries = Object.entries(ext.transport.env);
      if (envEntries.length > 0) {
        // Scoped to the stdio server table so project shell commands do not inherit MCP-only variables.
        const pairs = envEntries.map(([envName, envValue]) => `${tomlKey(envName)}=${tomlString(envValue)}`);
        fields.push(`env={${pairs.join(',')}}`);
      }
      args.push('-c', `mcp_servers.${key}={${fields.join(',')}}`);
    }
  }

  return { args, env, trustedDirs: [] };
}

function prepareGeminiExtensions(
  mcpExtensions: readonly StoredMcpExtension[],
  skills: readonly ResolvedSkillEntry[],
  extDir: string,
): PreparedExtensions {
  const agyWorkspace = join(extDir, 'agy');
  mkdirSync(agyWorkspace, { recursive: true, mode: 0o700 });

  if (mcpExtensions.length > 0) {
    const pluginDir = join(agyWorkspace, '.agents', 'plugins', 'cerebro-mcp');
    mkdirSync(pluginDir, { recursive: true, mode: 0o700 });

    const mcpServers: Record<string, object> = {};
    for (const ext of mcpExtensions) {
      if (ext.transport.type === 'http') {
        const hasHeaders = Object.keys(ext.transport.headers).length > 0;
        mcpServers[ext.name] = {
          url: ext.transport.url,
          ...(hasHeaders ? { headers: ext.transport.headers } : {}),
        };
      } else {
        const hasArgs = ext.transport.args.length > 0;
        const hasEnv = Object.keys(ext.transport.env).length > 0;
        mcpServers[ext.name] = {
          command: ext.transport.command,
          ...(hasArgs ? { args: ext.transport.args } : {}),
          ...(hasEnv ? { env: ext.transport.env } : {}),
        };
      }
    }

    writeFileSync(
      join(pluginDir, 'plugin.json'),
      `${JSON.stringify({ name: 'cerebro-mcp', version: '1.0.0' }, null, 2)}\n`,
      { mode: 0o600 },
    );
    writeFileSync(join(pluginDir, 'mcp_config.json'), `${JSON.stringify({ mcpServers }, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  if (skills.length > 0) {
    // Materialize inside `agyWorkspace` so `agy`'s `os.OpenRoot` workspace confinement never skips cross-root symlinks.
    const skillsDir = join(agyWorkspace, '.agents', 'skills');
    mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
    for (const skill of skills) {
      cpSync(skill.dirPath, join(skillsDir, skill.slug), { recursive: true, dereference: true });
    }
  }

  return { args: ['--add-dir', agyWorkspace], env: {}, trustedDirs: [agyWorkspace] };
}

export function formatGrokMcpToml(mcpExtensions: readonly StoredMcpExtension[]): string {
  const blocks: string[] = [];
  for (const ext of mcpExtensions) {
    const key = tomlKey(ext.name);
    const lines = [`[mcp_servers.${key}]`];
    if (ext.transport.type === 'http') {
      lines.push(`url = ${tomlString(ext.transport.url)}`);
      lines.push('enabled = true');
      const headers = Object.entries(ext.transport.headers);
      if (headers.length > 0) {
        lines.push('', `[mcp_servers.${key}.headers]`);
        for (const [headerName, headerValue] of headers) {
          lines.push(`${tomlKey(headerName)} = ${tomlString(headerValue)}`);
        }
      }
    } else {
      lines.push(`command = ${tomlString(ext.transport.command)}`);
      if (ext.transport.args.length > 0) {
        lines.push(`args = [${ext.transport.args.map(tomlString).join(', ')}]`);
      }
      lines.push('enabled = true');
      const envEntries = Object.entries(ext.transport.env);
      if (envEntries.length > 0) {
        lines.push('', `[mcp_servers.${key}.env]`);
        for (const [envName, envValue] of envEntries) {
          lines.push(`${tomlKey(envName)} = ${tomlString(envValue)}`);
        }
      }
    }
    blocks.push(lines.join('\n'));
  }
  return `${blocks.join('\n\n')}\n`;
}

function prepareGrokExtensions(
  mcpExtensions: readonly StoredMcpExtension[],
  skills: readonly ResolvedSkillEntry[],
  extDir: string,
  baseGrokHome: string,
): PreparedExtensions {
  const grokHomeDir = join(extDir, 'grok-home');
  mkdirSync(grokHomeDir, { recursive: true, mode: 0o700 });
  // Ensure `sessions` and `hooks` exist in the user's Grok home so transcripts and hooks outlive session cleanup.
  for (const shared of ['sessions', 'hooks']) {
    mkdirSync(join(baseGrokHome, shared), { recursive: true, mode: 0o700 });
  }

  for (const name of safeEntries(baseGrokHome)) {
    if (
      name === 'config.toml' ||
      name === 'leader.sock' ||
      name === 'leader.sock.daemon' ||
      name.startsWith('sandbox-blocked') ||
      (skills.length > 0 && name === 'skills')
    ) {
      continue;
    }
    symlinkSync(join(baseGrokHome, name), join(grokHomeDir, name));
  }

  if (skills.length > 0) {
    symlinkSkillsInto(join(grokHomeDir, 'skills'), join(baseGrokHome, 'skills'), skills);
  }

  let baseConfig: string;
  try {
    baseConfig = readFileSync(join(baseGrokHome, 'config.toml'), 'utf8');
  } catch {
    baseConfig = '';
  }
  if (mcpExtensions.length > 0) {
    const separator = baseConfig === '' ? '' : baseConfig.endsWith('\n') ? '\n' : '\n\n';
    writeFileSync(join(grokHomeDir, 'config.toml'), `${baseConfig}${separator}${formatGrokMcpToml(mcpExtensions)}`, {
      mode: 0o600,
    });
  } else if (baseConfig !== '') {
    writeFileSync(join(grokHomeDir, 'config.toml'), baseConfig, { mode: 0o600 });
  }

  // Short path to stay well below Linux's 108-byte `sun_path` limit (including `.daemon`).
  const leaderSocket = join(extDir, 'l.s');
  return {
    args: ['--leader-socket', leaderSocket],
    env: { GROK_HOME: grokHomeDir },
    trustedDirs: [],
  };
}

/**
 * Prepares per-session extension artifacts (MCP servers and skill packs) without writing anything to the project's Git
 * repository:
 * - `claude`: `--mcp-config` (0600 JSON) and/or `--plugin-dir` with symlinked skills;
 * - `codex`: `-c mcp_servers.<name>=...` overrides and/or isolated `CODEX_HOME` sharing `~/.codex/sessions` and SQLite;
 * - `gemini` (`agy`): isolated customization directory passed via `--add-dir` and added to `trustedWorkspaces`;
 * - `grok`: isolated `GROK_HOME` sharing sessions/hooks/auth via symlinks, merged `config.toml` and `skills/`.
 */
export function prepareSessionExtensions(
  agent: Agent,
  extensions: readonly StoredExtension[],
  sessionsDir: string,
  sessionId: string,
  grokHome = defaultGrokHome(),
  codexHome = defaultCodexHome(),
): PreparedExtensions {
  const mcpExtensions = extensions.filter((ext): ext is StoredMcpExtension => ext.kind === 'mcp');
  const skillExtensions = extensions.filter((ext): ext is StoredSkillExtension => ext.kind === 'skill');
  assertValidSkillExtensions(skillExtensions);
  const skills = collectSessionSkills(skillExtensions);
  if (mcpExtensions.length === 0 && skills.length === 0) return EMPTY_PREPARED;

  const extDir = sessionExtensionsDir(sessionsDir, sessionId);
  rmSync(extDir, { recursive: true, force: true });

  switch (agent) {
    case 'claude':
      return prepareClaudeExtensions(mcpExtensions, skills, extDir);
    case 'codex':
      return prepareCodexExtensions(mcpExtensions, skills, extDir, codexHome);
    case 'gemini':
      return prepareGeminiExtensions(mcpExtensions, skills, extDir);
    case 'grok':
      return prepareGrokExtensions(mcpExtensions, skills, extDir, grokHome);
  }
}

function preserveRefreshedAuth(isolatedHomeDir: string, realHomeDir: string): void {
  const isolatedAuth = join(isolatedHomeDir, 'auth.json');
  try {
    const stat = lstatSync(isolatedAuth);
    if (stat.isFile() && !stat.isSymbolicLink() && existsSync(realHomeDir)) {
      copyFileSync(isolatedAuth, join(realHomeDir, 'auth.json'));
    }
  } catch {
    // No `auth.json` present or copy not needed.
  }
}

/**
 * Removes per-session extension artifacts. If Grok or Codex atomically replaced `auth.json` during an OAuth refresh
 * inside its isolated home directory, the refreshed file is copied back before deletion.
 */
export function cleanupSessionExtensions(
  sessionsDir: string,
  sessionId: string,
  grokHome = defaultGrokHome(),
  codexHome = defaultCodexHome(),
): void {
  const extDir = sessionExtensionsDir(sessionsDir, sessionId);
  if (!existsSync(extDir)) return;
  preserveRefreshedAuth(join(extDir, 'grok-home'), grokHome);
  preserveRefreshedAuth(join(extDir, 'codex-home'), codexHome);
  rmSync(extDir, { recursive: true, force: true });
}
