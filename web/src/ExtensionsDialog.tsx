import { useEffect, useState, type FormEvent } from 'react';
import { ActivityStatus } from './ActivityStatus.tsx';
import { useAsyncAction } from './async-action.ts';
import { ChoiceGroup } from './ChoiceGroup.tsx';
import { DelayedActionButton } from './DelayedActionButton.tsx';
import { Modal } from './Dialog.tsx';
import { errorMessage, plural } from './format.ts';
import { useStore } from './store.tsx';
import {
  EXTENSION_NAME_PATTERN,
  MAX_EXTENSION_DESCRIPTION_LENGTH,
  MAX_EXTENSION_NAME_LENGTH,
  MAX_MCP_COMMAND_LENGTH,
  MAX_MCP_SECRET_NAME_LENGTH,
  MAX_MCP_SECRET_VALUE_LENGTH,
  MAX_MCP_URL_LENGTH,
  MAX_SKILL_PATH_LENGTH,
  type Extension,
  type ExtensionInput,
  type SecretEntriesInput,
} from '../../shared/types.ts';

type ExtensionKind = 'mcp' | 'skill';
type TransportKind = 'http' | 'stdio';

interface SecretRow {
  rowId: number;
  name: string;
  value: string;
  /** True while keeping the secret value already stored on the server (sent as `null`). */
  keepSaved: boolean;
}

interface ExtensionDraft {
  id: string | null;
  kind: ExtensionKind;
  name: string;
  description: string;
  transportKind: TransportKind;
  url: string;
  headers: SecretRow[];
  command: string;
  argsText: string;
  env: SecretRow[];
  path: string;
}

let nextSecretRowId = 1;

function emptyDraft(kind: ExtensionKind = 'mcp'): ExtensionDraft {
  return {
    id: null,
    kind,
    name: '',
    description: '',
    transportKind: 'http',
    url: '',
    headers: [],
    command: '',
    argsText: '',
    env: [],
    path: '',
  };
}

function draftFromExtension(ext: Extension): ExtensionDraft {
  if (ext.kind === 'skill') {
    return {
      ...emptyDraft('skill'),
      id: ext.id,
      name: ext.name,
      description: ext.description,
      path: ext.path,
    };
  }
  if (ext.transport.type === 'http') {
    return {
      id: ext.id,
      kind: 'mcp',
      name: ext.name,
      description: ext.description,
      transportKind: 'http',
      url: ext.transport.url,
      headers: ext.transport.headerNames.map((name) => ({
        rowId: nextSecretRowId++,
        name,
        value: '',
        keepSaved: true,
      })),
      command: '',
      argsText: '',
      env: [],
      path: '',
    };
  }
  return {
    id: ext.id,
    kind: 'mcp',
    name: ext.name,
    description: ext.description,
    transportKind: 'stdio',
    url: '',
    headers: [],
    command: ext.transport.command,
    argsText: ext.transport.args.join('\n'),
    env: ext.transport.envNames.map((name) => ({
      rowId: nextSecretRowId++,
      name,
      value: '',
      keepSaved: true,
    })),
    path: '',
  };
}

function toSecretInput(rows: SecretRow[]): SecretEntriesInput {
  const out: SecretEntriesInput = {};
  for (const row of rows) {
    const key = row.name.trim();
    if (key === '') continue;
    out[key] = row.keepSaved ? null : row.value;
  }
  return out;
}

function buildInput(draft: ExtensionDraft): ExtensionInput {
  if (draft.kind === 'skill') {
    return {
      kind: 'skill',
      name: draft.name.trim(),
      description: draft.description.trim(),
      path: draft.path.trim(),
    };
  }
  if (draft.transportKind === 'http') {
    const headers = toSecretInput(draft.headers);
    return {
      kind: 'mcp',
      name: draft.name.trim(),
      description: draft.description.trim(),
      transport: {
        type: 'http',
        url: draft.url.trim(),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
    };
  }
  const args = draft.argsText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const env = toSecretInput(draft.env);
  return {
    kind: 'mcp',
    name: draft.name.trim(),
    description: draft.description.trim(),
    transport: {
      type: 'stdio',
      command: draft.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    },
  };
}

function SecretRowsEditor({
  legend,
  addLabel,
  namePlaceholder,
  valuePlaceholder,
  allowEmptyValue,
  rows,
  disabled,
  onChange,
}: {
  legend: string;
  addLabel: string;
  namePlaceholder: string;
  valuePlaceholder: string;
  allowEmptyValue: boolean;
  rows: SecretRow[];
  disabled: boolean;
  onChange: (rows: SecretRow[]) => void;
}) {
  return (
    <div className="ext-secrets" role="group" aria-label={legend}>
      <div className="ext-secrets-head">
        <span className="field-label">{legend}</span>
        <button
          type="button"
          className="btn"
          disabled={disabled}
          onClick={() => onChange([...rows, { rowId: nextSecretRowId++, name: '', value: '', keepSaved: false }])}
        >
          {addLabel}
        </button>
      </div>
      {rows.map((row) => (
        <div key={row.rowId} className="ext-secret-row">
          <input
            aria-label="Nom"
            placeholder={namePlaceholder}
            maxLength={MAX_MCP_SECRET_NAME_LENGTH}
            value={row.name}
            disabled={disabled || row.keepSaved}
            onChange={(event) =>
              onChange(rows.map((r) => (r.rowId === row.rowId ? { ...r, name: event.target.value } : r)))
            }
          />
          {row.keepSaved ? (
            <>
              <span className="hint ext-secret-saved">Valeur enregistrée</span>
              <button
                type="button"
                className="btn"
                disabled={disabled}
                onClick={() =>
                  onChange(rows.map((r) => (r.rowId === row.rowId ? { ...r, keepSaved: false, value: '' } : r)))
                }
              >
                Remplacer
              </button>
            </>
          ) : (
            <input
              type="password"
              aria-label="Valeur"
              placeholder={valuePlaceholder}
              required={!allowEmptyValue && row.name.trim() !== ''}
              maxLength={MAX_MCP_SECRET_VALUE_LENGTH}
              value={row.value}
              disabled={disabled}
              autoComplete="off"
              onChange={(event) =>
                onChange(rows.map((r) => (r.rowId === row.rowId ? { ...r, value: event.target.value } : r)))
              }
            />
          )}
          <button
            type="button"
            className="btn"
            disabled={disabled}
            onClick={() => onChange(rows.filter((r) => r.rowId !== row.rowId))}
          >
            Retirer
          </button>
        </div>
      ))}
    </div>
  );
}

function ExtensionForm({
  draft,
  busy,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  draft: ExtensionDraft;
  busy: boolean;
  error: string | null;
  onChange: (draft: ExtensionDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const trimmedName = draft.name.trim();
  const validName = trimmedName !== '' && EXTENSION_NAME_PATTERN.test(trimmedName);
  const validTarget =
    draft.kind === 'skill'
      ? draft.path.trim() !== ''
      : draft.transportKind === 'http'
        ? draft.url.trim() !== ''
        : draft.command.trim() !== '';
  const invalid = !validName || !validTarget;

  return (
    <form
      className="extension-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (!invalid) onSubmit();
      }}
    >
      <div className="ext-form-top">
        <label>
          Nom (lettres, chiffres, - ou _)
          <input
            autoFocus
            required
            maxLength={MAX_EXTENSION_NAME_LENGTH}
            placeholder={draft.kind === 'skill' ? 'open-data-skills' : 'data-gouv'}
            value={draft.name}
            disabled={busy}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </label>
        <div className="ext-transport-field">
          <span className="field-label">Type</span>
          <ChoiceGroup<ExtensionKind>
            compact
            label="Type d’extension"
            value={draft.kind}
            disabled={busy}
            options={[
              { value: 'mcp', label: 'MCP', title: 'Serveur MCP distant (HTTP) ou local (stdio)' },
              {
                value: 'skill',
                label: 'Skills',
                title: 'Dossier local contenant un SKILL.md ou plusieurs sous-dossiers <nom>/SKILL.md',
              },
            ]}
            onChange={(kind) => onChange({ ...draft, kind })}
          />
        </div>
        {draft.kind === 'mcp' ? (
          <div className="ext-transport-field">
            <span className="field-label">Transport</span>
            <ChoiceGroup<TransportKind>
              compact
              label="Transport MCP"
              value={draft.transportKind}
              disabled={busy}
              options={[
                { value: 'http', label: 'HTTP', title: 'Serveur MCP Streamable HTTP (URL https://…)' },
                { value: 'stdio', label: 'stdio', title: 'Exécutable lancé localement en entrée/sortie standard' },
              ]}
              onChange={(transportKind) => onChange({ ...draft, transportKind })}
            />
          </div>
        ) : null}
      </div>
      {draft.kind === 'skill' ? (
        <div className="ext-skill-fields">
          <label>
            Dossier sur cette machine
            <input
              required
              maxLength={MAX_SKILL_PATH_LENGTH}
              placeholder="~/CodePerso/mes-skills"
              value={draft.path}
              disabled={busy}
              onChange={(event) => onChange({ ...draft, path: event.target.value })}
            />
          </label>
          <p className="hint ext-field-hint">
            Dossier contenant directement un fichier <code>SKILL.md</code> (skill unique) ou plusieurs sous-dossiers{' '}
            <code>&lt;nom&gt;/SKILL.md</code> (pack de skills).
          </p>
        </div>
      ) : draft.transportKind === 'http' ? (
        <label>
          URL du serveur MCP
          <input
            type="url"
            required
            maxLength={MAX_MCP_URL_LENGTH}
            placeholder="https://mcp.data.gouv.fr/mcp"
            value={draft.url}
            disabled={busy}
            onChange={(event) => onChange({ ...draft, url: event.target.value })}
          />
        </label>
      ) : (
        <div className="ext-stdio-fields">
          <label>
            Commande
            <input
              required
              maxLength={MAX_MCP_COMMAND_LENGTH}
              placeholder="npx"
              value={draft.command}
              disabled={busy}
              onChange={(event) => onChange({ ...draft, command: event.target.value })}
            />
          </label>
          <label>
            Arguments (un par ligne, facultatif)
            <textarea
              rows={2}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
              value={draft.argsText}
              disabled={busy}
              onChange={(event) => onChange({ ...draft, argsText: event.target.value })}
            />
          </label>
        </div>
      )}
      <label>
        Description (facultatif)
        <input
          maxLength={MAX_EXTENSION_DESCRIPTION_LENGTH}
          placeholder={
            draft.kind === 'skill'
              ? 'Procédures et scripts métier pour l’API Sirene'
              : 'Jeux de données publics français (data.gouv.fr)'
          }
          value={draft.description}
          disabled={busy}
          onChange={(event) => onChange({ ...draft, description: event.target.value })}
        />
      </label>
      {draft.kind === 'mcp' ? (
        draft.transportKind === 'http' ? (
          <SecretRowsEditor
            legend="En-têtes HTTP (facultatif)"
            addLabel="Ajouter un en-tête"
            namePlaceholder="Authorization"
            valuePlaceholder="Bearer …"
            allowEmptyValue={false}
            rows={draft.headers}
            disabled={busy}
            onChange={(headers) => onChange({ ...draft, headers })}
          />
        ) : (
          <SecretRowsEditor
            legend="Variables d’environnement (facultatif)"
            addLabel="Ajouter une variable"
            namePlaceholder="API_KEY"
            valuePlaceholder="Valeur secrète"
            allowEmptyValue
            rows={draft.env}
            disabled={busy}
            onChange={(env) => onChange({ ...draft, env })}
          />
        )
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={busy || invalid}>
          <ActivityStatus active={busy}>
            {busy ? 'Enregistrement…' : draft.id === null ? 'Ajouter' : 'Enregistrer'}
          </ActivityStatus>
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}

export function extensionTargetSummary(ext: Extension): string {
  if (ext.kind === 'skill') return ext.path;
  if (ext.transport.type === 'http') return ext.transport.url;
  return [ext.transport.command, ...ext.transport.args].join(' ');
}

export function extensionBadgeLabel(ext: Extension): string {
  if (ext.kind === 'skill') {
    return ext.skills.length > 1 ? `Skills (${ext.skills.length})` : 'Skill';
  }
  return ext.transport.type === 'http' ? 'MCP · HTTP' : 'MCP · stdio';
}

function ExtensionSubLine({ ext }: { ext: Extension }) {
  if (ext.kind === 'skill') {
    if (ext.missing) {
      return (
        <p className="extension-sub">
          {ext.description ? <span>{ext.description} · </span> : null}
          <span className="ext-missing-note">
            Ce dossier n’existe plus ou ne contient plus de fichier SKILL.md — modifiez son chemin.
          </span>
        </p>
      );
    }
    const skillNames = ext.skills.map((s) => s.name).join(', ');
    const skillDetails = ext.skills.map((s) => (s.description ? `${s.name} : ${s.description}` : s.name)).join('\n');
    if (!ext.description && skillNames === '') return null;
    return (
      <p className="extension-sub">
        {ext.description ? <span>{ext.description}</span> : null}
        {ext.description && skillNames !== '' ? ' · ' : null}
        {skillNames !== '' ? (
          <span className="meta" title={skillDetails}>
            {ext.skills.length > 1 ? 'Skills détectées' : 'Skill détectée'} : {skillNames}
          </span>
        ) : null}
      </p>
    );
  }

  const secretNames = ext.transport.type === 'http' ? ext.transport.headerNames : ext.transport.envNames;
  const secretLabel = ext.transport.type === 'http' ? 'En-têtes' : 'Variables';
  if (!ext.description && secretNames.length === 0) return null;
  return (
    <p className="extension-sub">
      {ext.description ? <span>{ext.description}</span> : null}
      {ext.description && secretNames.length > 0 ? ' · ' : null}
      {secretNames.length > 0 ? (
        <span className="meta">
          {secretLabel} : {secretNames.join(', ')}
        </span>
      ) : null}
    </p>
  );
}

/** Global catalog dialog for machine-level optional extensions (MCP servers and local skill folders). */
export function ExtensionsDialog({ onClose }: { onClose: () => void }) {
  const { extensions, projects, refreshExtensions, createExtension, updateExtension, deleteExtension } = useStore();
  const [draft, setDraft] = useState<ExtensionDraft | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    void refreshExtensions?.().catch(() => {});
  }, [refreshExtensions]);

  const {
    run: saveDraft,
    busy,
    error: formError,
    setError: setFormError,
  } = useAsyncAction(async (current: ExtensionDraft) => {
    const input = buildInput(current);
    if (current.id === null) await createExtension(input);
    else await updateExtension(current.id, input);
    setDraft(null);
  });

  const edit = (next: ExtensionDraft | null): void => {
    setDraft(next);
    setFormError(null);
    setDeleteError(null);
  };

  const remove = async (ext: Extension): Promise<void> => {
    setDeleting(ext.id);
    setDeleteError(null);
    try {
      await deleteExtension(ext.id);
      if (draft?.id === ext.id) setDraft(null);
    } catch (cause) {
      setDeleteError(`Suppression de « ${ext.name} » impossible : ${errorMessage(cause)}`);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <Modal title="Catalogue des fonctionnalités supplémentaires" onClose={onClose}>
      <div className="extensions-dialog">
        <p className="hint">
          Serveurs MCP (HTTP ou <code>stdio</code>) et dossiers locaux de skills déclarés une fois pour toutes, montés
          uniquement dans les sessions des projets où ils sont activés (Claude, Codex, Gemini, Grok) sans toucher aux
          dépôts Git.
        </p>
        {deleteError ? (
          <p className="form-error" role="alert">
            {deleteError}
          </p>
        ) : null}
        {extensions.length === 0 && draft === null ? (
          <p className="empty-hint">Aucune fonctionnalité déclarée sur cette machine.</p>
        ) : null}
        {extensions.length > 0 ? (
          <ul className="extension-list">
            {extensions.map((ext) => {
              const usedBy = projects.filter((p) => p.extensionIds.includes(ext.id));
              return (
                <li key={ext.id} className="extension-item">
                  {draft?.id === ext.id ? (
                    <ExtensionForm
                      draft={draft}
                      busy={busy}
                      error={formError}
                      onChange={setDraft}
                      onSubmit={() => void saveDraft(draft)}
                      onCancel={() => edit(null)}
                    />
                  ) : (
                    <>
                      <div className="extension-summary">
                        <div className="extension-head">
                          <strong>{ext.name}</strong>
                          <span className="pill">{extensionBadgeLabel(ext)}</span>
                          {ext.kind === 'skill' && ext.missing ? (
                            <span className="pill ext-missing-pill">Dossier introuvable</span>
                          ) : null}
                          <code className="extension-target">{extensionTargetSummary(ext)}</code>
                          {usedBy.length > 0 ? (
                            <span className="meta" title={usedBy.map((p) => p.name).join(', ')}>
                              · {plural(usedBy.length, 'projet')}
                            </span>
                          ) : null}
                        </div>
                        <ExtensionSubLine ext={ext} />
                      </div>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="btn"
                          disabled={busy || deleting !== null}
                          onClick={() => edit(draftFromExtension(ext))}
                        >
                          Modifier
                        </button>
                        <DelayedActionButton
                          disabled={busy || deleting !== null}
                          title={`Supprime « ${ext.name} » du catalogue et le retire des projets qui l’activaient`}
                          onAction={() => void remove(ext)}
                        >
                          {deleting === ext.id ? <ActivityStatus>Suppression…</ActivityStatus> : 'Supprimer'}
                        </DelayedActionButton>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
        {draft !== null && draft.id === null ? (
          <div className="extension-item">
            <ExtensionForm
              draft={draft}
              busy={busy}
              error={formError}
              onChange={setDraft}
              onSubmit={() => void saveDraft(draft)}
              onCancel={() => edit(null)}
            />
          </div>
        ) : null}
        <div className="row-actions">
          {draft === null || draft.id !== null ? (
            <>
              <button type="button" className="btn primary" disabled={busy} onClick={() => edit(emptyDraft('mcp'))}>
                Nouveau serveur MCP
              </button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => edit(emptyDraft('skill'))}>
                Nouveau dossier de skills
              </button>
            </>
          ) : null}
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </Modal>
  );
}
