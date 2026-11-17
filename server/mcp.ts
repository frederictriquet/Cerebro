import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '../shared/types.ts';
import type { StoredExtension, StoredMcpExtension } from './db.ts';

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

/** Valid TOML basic string (UTF-8 sanitized, standard escapes). */
export function tomlString(value: string): string {
  return JSON.stringify(Buffer.from(value, 'utf8').toString('utf8'));
}

export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

function prepareClaudeMcp(mcpExtensions: StoredMcpExtension[], extDir: string): PreparedExtensions {
  mkdirSync(extDir, { recursive: true, mode: 0o700 });
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
  return { args: ['--mcp-config', configPath], env: {}, trustedDirs: [] };
}

function prepareCodexMcp(mcpExtensions: StoredMcpExtension[]): PreparedExtensions {
  const args: string[] = [];
  const env: Record<string, string> = {};
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

function prepareGeminiMcp(mcpExtensions: StoredMcpExtension[], extDir: string): PreparedExtensions {
  const agyWorkspace = join(extDir, 'agy');
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

  return { args: ['--add-dir', agyWorkspace], env: {}, trustedDirs: [agyWorkspace] };
}

export function formatGrokMcpToml(mcpExtensions: StoredMcpExtension[]): string {
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

function prepareGrokMcp(mcpExtensions: StoredMcpExtension[], extDir: string, baseGrokHome: string): PreparedExtensions {
  const grokHomeDir = join(extDir, 'grok-home');
  mkdirSync(grokHomeDir, { recursive: true, mode: 0o700 });
  // Ensure `sessions` and `hooks` exist in the user's Grok home so transcripts and hooks outlive session cleanup.
  for (const shared of ['sessions', 'hooks']) {
    mkdirSync(join(baseGrokHome, shared), { recursive: true, mode: 0o700 });
  }

  let entries: string[];
  try {
    entries = readdirSync(baseGrokHome);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (
      name === 'config.toml' ||
      name === 'leader.sock' ||
      name === 'leader.sock.daemon' ||
      name.startsWith('sandbox-blocked')
    ) {
      continue;
    }
    symlinkSync(join(baseGrokHome, name), join(grokHomeDir, name));
  }

  let baseConfig: string;
  try {
    baseConfig = readFileSync(join(baseGrokHome, 'config.toml'), 'utf8');
  } catch {
    baseConfig = '';
  }
  const separator = baseConfig === '' ? '' : baseConfig.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(join(grokHomeDir, 'config.toml'), `${baseConfig}${separator}${formatGrokMcpToml(mcpExtensions)}`, {
    mode: 0o600,
  });

  // Short path to stay well below Linux's 108-byte `sun_path` limit (including `.daemon`).
  const leaderSocket = join(extDir, 'l.s');
  return {
    args: ['--leader-socket', leaderSocket],
    env: { GROK_HOME: grokHomeDir },
    trustedDirs: [],
  };
}

/**
 * Prepares per-session extension artifacts without writing anything to the project's Git repository:
 * - `claude`: 0600 JSON file passed via `--mcp-config`;
 * - `codex`: `-c mcp_servers.<name>=...` overrides with HTTP auth headers in `CEREBRO_MCP_HDR_*` env vars;
 * - `gemini` (`agy`): isolated plugin directory passed via `--add-dir` and added to `trustedWorkspaces`;
 * - `grok`: isolated `GROK_HOME` sharing sessions/hooks/plugins via symlinks and a dedicated `--leader-socket`.
 */
export function prepareSessionExtensions(
  agent: Agent,
  extensions: readonly StoredExtension[],
  sessionsDir: string,
  sessionId: string,
  grokHome = defaultGrokHome(),
): PreparedExtensions {
  const mcpExtensions = extensions.filter((ext): ext is StoredMcpExtension => ext.kind === 'mcp');
  if (mcpExtensions.length === 0) return EMPTY_PREPARED;
  const extDir = sessionExtensionsDir(sessionsDir, sessionId);
  rmSync(extDir, { recursive: true, force: true });

  switch (agent) {
    case 'claude':
      return prepareClaudeMcp(mcpExtensions, extDir);
    case 'codex':
      return prepareCodexMcp(mcpExtensions);
    case 'gemini':
      return prepareGeminiMcp(mcpExtensions, extDir);
    case 'grok':
      return prepareGrokMcp(mcpExtensions, extDir, grokHome);
  }
}

/**
 * Removes per-session extension artifacts. If Grok atomically replaced `auth.json` during an OAuth refresh inside its
 * isolated `GROK_HOME`, the refreshed file is copied back to `~/.grok/auth.json` before deletion.
 */
export function cleanupSessionExtensions(sessionsDir: string, sessionId: string, grokHome = defaultGrokHome()): void {
  const extDir = sessionExtensionsDir(sessionsDir, sessionId);
  if (!existsSync(extDir)) return;
  const isolatedAuth = join(extDir, 'grok-home', 'auth.json');
  try {
    const stat = lstatSync(isolatedAuth);
    if (stat.isFile() && !stat.isSymbolicLink() && existsSync(grokHome)) {
      copyFileSync(isolatedAuth, join(grokHome, 'auth.json'));
    }
  } catch {
    // No isolated `auth.json` or directory already removed.
  }
  rmSync(extDir, { recursive: true, force: true });
}
