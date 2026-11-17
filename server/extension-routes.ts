import { homedir } from 'node:os';
import {
  EXTENSION_NAME_PATTERN,
  MAX_EXTENSION_DESCRIPTION_LENGTH,
  MAX_EXTENSION_NAME_LENGTH,
  MAX_MCP_ARG_LENGTH,
  MAX_MCP_ARGS,
  MAX_MCP_COMMAND_LENGTH,
  MAX_MCP_ENV_VARS,
  MAX_MCP_HEADERS,
  MAX_MCP_SECRET_NAME_LENGTH,
  MAX_MCP_SECRET_VALUE_LENGTH,
  MAX_MCP_URL_LENGTH,
  MAX_SKILL_PATH_LENGTH,
} from '../shared/types.ts';
import type { CerebroDatabase, StoredExtension, StoredExtensionInput } from './db.ts';
import type { RouteContext } from './route-context.ts';
import { error } from './routes-util.ts';
import { expandSkillPath, inspectSkillDirectory, isGlobalAgentSkillDir } from './skills.ts';
import { asRecord } from './util.ts';

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ValidatedExtensionInput = StoredExtensionInput;

function hasControlLineChars(value: string): boolean {
  return value.includes('\r') || value.includes('\n') || value.includes('\0');
}

function validateSecretsMap(
  raw: unknown,
  previous: Record<string, string>,
  options: {
    maxEntries: number;
    keyPattern: RegExp;
    allowEmptyValue: boolean;
    forbidCerebroPrefix: boolean;
    kindLabel: string;
  },
): { ok: true; entries: Record<string, string> } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, entries: {} };
  const record = asRecord(raw);
  if (record === null) return { ok: false, message: `${options.kindLabel} invalides (objet attendu)` };
  const keys = Object.keys(record);
  if (keys.length > options.maxEntries) {
    return { ok: false, message: `Trop de ${options.kindLabel.toLowerCase()} (${options.maxEntries} au plus)` };
  }
  const out: Record<string, string> = {};
  for (const rawKey of keys) {
    const key = rawKey.trim();
    if (key === '' || key.length > MAX_MCP_SECRET_NAME_LENGTH || !options.keyPattern.test(key)) {
      return { ok: false, message: `Nom invalide dans ${options.kindLabel.toLowerCase()} : « ${rawKey} »` };
    }
    if (options.forbidCerebroPrefix && key.startsWith('CEREBRO_')) {
      return { ok: false, message: `La variable « ${key} » est réservée à Cerebro` };
    }
    if (key in out) {
      return { ok: false, message: `Entrée en doublon : « ${key} »` };
    }
    const val = record[rawKey];
    if (val === null) {
      if (!(key in previous)) {
        return { ok: false, message: `Aucune valeur enregistrée à conserver pour « ${key} »` };
      }
      out[key] = previous[key];
      continue;
    }
    if (typeof val !== 'string') {
      return { ok: false, message: `Valeur invalide pour « ${key} »` };
    }
    if (val.includes('\0') || (!options.allowEmptyValue && (val.trim() === '' || hasControlLineChars(val)))) {
      return { ok: false, message: `Valeur invalide pour « ${key} »` };
    }
    if (val.length > MAX_MCP_SECRET_VALUE_LENGTH) {
      return {
        ok: false,
        message: `La valeur de « ${key} » dépasse ${MAX_MCP_SECRET_VALUE_LENGTH} caractères`,
      };
    }
    out[key] = options.allowEmptyValue ? val : val.trim();
  }
  return { ok: true, entries: out };
}

export function validateExtensionInput(
  raw: unknown,
  existing: StoredExtension | null = null,
  home = homedir(),
): { ok: true; value: ValidatedExtensionInput } | { ok: false; message: string } {
  const body = asRecord(raw);
  if (body === null) return { ok: false, message: 'Corps de requête invalide' };
  if (body.kind !== 'mcp' && body.kind !== 'skill') {
    return { ok: false, message: "Type d'extension non pris en charge (mcp ou skill attendu)" };
  }

  if (typeof body.name !== 'string') return { ok: false, message: 'Le nom est requis' };
  const name = body.name.trim();
  if (name === '' || name.length > MAX_EXTENSION_NAME_LENGTH || !EXTENSION_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      message: `Le nom doit contenir de 1 à ${MAX_EXTENSION_NAME_LENGTH} caractères (lettres, chiffres, tirets ou underscores, ex. data-gouv)`,
    };
  }

  let description = '';
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') return { ok: false, message: 'Description invalide' };
    description = body.description.trim();
    if (description.length > MAX_EXTENSION_DESCRIPTION_LENGTH) {
      return {
        ok: false,
        message: `La description ne peut pas dépasser ${MAX_EXTENSION_DESCRIPTION_LENGTH} caractères`,
      };
    }
  }

  if (body.kind === 'skill') {
    if (typeof body.path !== 'string') return { ok: false, message: 'Le chemin du dossier de skills est requis' };
    const rawPath = body.path.trim();
    if (rawPath === '' || rawPath.length > MAX_SKILL_PATH_LENGTH || hasControlLineChars(rawPath)) {
      return { ok: false, message: 'Chemin du dossier de skills invalide' };
    }
    const resolvedPath = expandSkillPath(rawPath, home);
    if (resolvedPath === null) {
      return { ok: false, message: 'Chemin invalide (indiquez un dossier absolu /… ou ~/…)' };
    }
    if (isGlobalAgentSkillDir(resolvedPath, home)) {
      return {
        ok: false,
        message:
          'Ce dossier appartient à un répertoire déjà chargé globalement par les agents ; utilisez un dossier dédié (ex. ~/CodePerso/mes-skills)',
      };
    }
    const inspected = inspectSkillDirectory(resolvedPath);
    if (!inspected.exists) {
      return { ok: false, message: 'Ce dossier est introuvable sur cette machine' };
    }
    if (inspected.skills.length === 0) {
      return {
        ok: false,
        message: 'Aucun fichier SKILL.md trouvé dans ce dossier ni dans ses sous-dossiers directs',
      };
    }
    return { ok: true, value: { kind: 'skill', name, description, path: resolvedPath } };
  }

  const transport = asRecord(body.transport);
  if (transport === null) return { ok: false, message: 'Configuration du transport MCP requise' };

  if (transport.type === 'http') {
    if (typeof transport.url !== 'string') return { ok: false, message: "L'URL du serveur MCP est requise" };
    const url = transport.url.trim();
    if (url === '' || url.length > MAX_MCP_URL_LENGTH || hasControlLineChars(url)) {
      return { ok: false, message: 'URL du serveur MCP invalide' };
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { ok: false, message: 'URL du serveur MCP invalide (http:// ou https:// attendu)' };
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { ok: false, message: "L'URL du serveur MCP doit utiliser http:// ou https://" };
    }
    const prevHeaders =
      existing?.kind === 'mcp' && existing.transport.type === 'http' ? existing.transport.headers : {};
    const headers = validateSecretsMap(transport.headers, prevHeaders, {
      maxEntries: MAX_MCP_HEADERS,
      keyPattern: HEADER_NAME_PATTERN,
      allowEmptyValue: false,
      forbidCerebroPrefix: false,
      kindLabel: 'En-têtes HTTP',
    });
    if (!headers.ok) return headers;
    return {
      ok: true,
      value: { kind: 'mcp', name, description, transport: { type: 'http', url, headers: headers.entries } },
    };
  }

  if (transport.type === 'stdio') {
    if (typeof transport.command !== 'string') return { ok: false, message: 'La commande du serveur MCP est requise' };
    const command = transport.command.trim();
    if (command === '' || command.length > MAX_MCP_COMMAND_LENGTH || hasControlLineChars(command)) {
      return { ok: false, message: 'Commande du serveur MCP invalide' };
    }
    let args: string[] = [];
    if (transport.args !== undefined) {
      if (!Array.isArray(transport.args) || transport.args.length > MAX_MCP_ARGS) {
        return { ok: false, message: `Arguments invalides (${MAX_MCP_ARGS} au plus)` };
      }
      for (const arg of transport.args) {
        if (typeof arg !== 'string' || arg.length > MAX_MCP_ARG_LENGTH || arg.includes('\0')) {
          return { ok: false, message: 'Argument de commande invalide' };
        }
      }
      args = transport.args as string[];
    }
    const prevEnv = existing?.kind === 'mcp' && existing.transport.type === 'stdio' ? existing.transport.env : {};
    const env = validateSecretsMap(transport.env, prevEnv, {
      maxEntries: MAX_MCP_ENV_VARS,
      keyPattern: ENV_NAME_PATTERN,
      allowEmptyValue: true,
      forbidCerebroPrefix: true,
      kindLabel: "Variables d'environnement",
    });
    if (!env.ok) return env;
    return {
      ok: true,
      value: { kind: 'mcp', name, description, transport: { type: 'stdio', command, args, env: env.entries } },
    };
  }

  return { ok: false, message: 'Transport MCP invalide (http ou stdio attendu)' };
}

export function parseExtensionIds(
  db: CerebroDatabase,
  raw: unknown,
): { ok: true; ids: string[] } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length > 100 || raw.some((item) => typeof item !== 'string')) {
    return { ok: false, message: "Liste d'identifiants d'extensions attendue (100 au plus)" };
  }
  const known = new Set(db.listExtensions().map((ext) => ext.id));
  const ids = [...new Set(raw as string[])];
  if (ids.some((id) => !known.has(id))) {
    return { ok: false, message: 'Extension introuvable dans le catalogue' };
  }
  return { ok: true, ids };
}

export function registerExtensionRoutes(ctx: RouteContext): void {
  const { app, db, broadcast } = ctx;

  app.get('/api/extensions', async () => db.listExtensions());

  app.post('/api/extensions', async (request, reply) => {
    const validated = validateExtensionInput(request.body, null);
    if (!validated.ok) return error(reply, 400, validated.message);
    if (db.findExtensionByName(validated.value.name) !== null) {
      return error(reply, 409, `Une extension porte déjà le nom « ${validated.value.name} »`);
    }
    const created = db.createExtension(validated.value);
    broadcast({ type: 'extensions', extensions: db.listExtensions() });
    return reply.code(201).send(created);
  });

  app.put<{ Params: { id: string } }>('/api/extensions/:id', async (request, reply) => {
    const existing = db.getStoredExtension(request.params.id);
    if (existing === null) return error(reply, 404, 'Extension introuvable');
    const validated = validateExtensionInput(request.body, existing);
    if (!validated.ok) return error(reply, 400, validated.message);
    const clash = db.findExtensionByName(validated.value.name);
    if (clash !== null && clash.id !== existing.id) {
      return error(reply, 409, `Une extension porte déjà le nom « ${validated.value.name} »`);
    }
    const updated = db.updateExtension(existing.id, validated.value);
    if (updated === null) return error(reply, 404, 'Extension introuvable');
    broadcast({ type: 'extensions', extensions: db.listExtensions() });
    return reply.send(updated);
  });

  app.delete<{ Params: { id: string } }>('/api/extensions/:id', async (request, reply) => {
    if (!db.deleteExtension(request.params.id)) return error(reply, 404, 'Extension introuvable');
    broadcast({ type: 'extensions', extensions: db.listExtensions() });
    broadcast({ type: 'projects', projects: db.listProjects() });
    return reply.code(204).send();
  });
}
