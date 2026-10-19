import type { EpicRun } from '../../server/epic-runner.ts';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api } from './api.ts';
import type { CommandRun, ProjectCommand } from '../../server/commands.ts';
import { DelayedActionButton } from './DelayedActionButton.tsx';
import { LaunchSessionDialog } from './Dialog.tsx';
import { STATUS_LABEL, sessionTitle } from './format.ts';
import { href } from './route.ts';
import { StatusDot } from './StatusDot.tsx';
import { useStore } from './store.tsx';
import type { Epic, Session, Task } from './types.ts';
import { isSubmitShortcut, SUBMIT_HINT } from './keys.ts';

export function taskTitle(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? text;
}

const TASK_STATUS_LABEL: Record<Task['status'], string> = {
  todo: 'À faire',
  started: 'En cours',
  done: 'Terminée',
};

// Tâches de `tasks` dont `id` dépend, directement ou non : en dépendre créerait un cycle.
function dependents(id: string, tasks: Task[]): Set<string> {
  const found = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const t of tasks) {
      if (t.dependsOn.includes(current) && !found.has(t.id)) {
        found.add(t.id);
        stack.push(t.id);
      }
    }
  }
  return found;
}

// Ordre de traitement des tâches : chacune après celles dont elle dépend parmi `tasks`, sinon dans
// l'ordre de création. Les dépendances hors de `tasks` sont ignorées.
export function dependencyOrder(tasks: Task[]): Task[] {
  const ids = new Set(tasks.map((t) => t.id));
  const placed = new Set<string>();
  const ordered: Task[] = [];
  let remaining = tasks;
  while (remaining.length > 0) {
    const ready = remaining.filter((t) => t.dependsOn.every((id) => !ids.has(id) || placed.has(id)));
    // Un cycle est refusé par le serveur ; par prudence on place le reste tel quel.
    const batch = ready.length > 0 ? ready.slice(0, 1) : remaining;
    for (const t of batch) {
      placed.add(t.id);
      ordered.push(t);
    }
    remaining = remaining.filter((t) => !placed.has(t.id));
  }
  return ordered;
}

// Prompt de la session qui traite tout l'epic : les tâches ouvertes dans l'ordre des dépendances,
// chacune close via cerebro-backlog une fois faite pour que le backlog suive l'avancement.
function epicPrompt(epic: Epic, _ordered: Task[]): string {
  return `Traiter l’epic « ${epic.title} ». Le serveur calcule l’ordre, lance chaque tâche et attend sa clôture explicite. Ne traite que l’étape confiée à chaque session.
${epic.description}`;
}

// Une tâche lancée suit l'état de sa session : « En cours » tant que l'agent travaille,
// puis « À valider » une fois son tour fini (la clôture reste manuelle).
function taskPill(task: Task, session: Session | undefined, blocked: boolean): { label: string; className: string } {
  if (task.status === 'todo' && blocked) return { label: 'Bloquée', className: 'blocked' };
  if (task.status !== 'started') return { label: TASK_STATUS_LABEL[task.status], className: task.status };
  if(task.execution?.type==='command')return {label:'Commande — voir résultat',className:'started'};
  switch (session?.status) {
    case 'starting':
    case 'running':
      return { label: 'En cours', className: 'started' };
    case 'waiting':
      return { label: 'En attente', className: 'waiting' };
    default:
      return { label: 'À valider', className: 'review' };
  }
}

export function Backlog({ projectId }: { projectId: string }) {
  const { tasks, epics, sessions, createTask, createEpic, startTask, startEpic, deleteTask } = useStore();
  const own = tasks.filter((t) => t.projectId === projectId);
  const ownEpics = epics.filter((e) => e.projectId === projectId);
  const epicIds = new Set(ownEpics.map((e) => e.id));
  const open = own.filter((t) => t.status !== 'done');
  const done = own.filter((t) => t.status === 'done');
  const [showDone, setShowDone] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftEpic, setDraftEpic] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<Task | null>(null);
  const [startingEpic, setStartingEpic] = useState<{ epic: Epic; prompt: string } | null>(null);
  const [creatingEpic, setCreatingEpic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [composer, setComposer] = useState<'llm' | 'command'>('llm');
  const llmTab = useRef<HTMLButtonElement>(null);
  const commandTab = useRef<HTMLButtonElement>(null);

  const add = async (): Promise<void> => {
    if (busy || draft.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await createTask(projectId, draft, undefined, epicIds.has(draftEpic) ? draftEpic : null);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ajout impossible');
    } finally {
      setBusy(false);
    }
  };

  const deleteDone = (): void => {
    setError(null);
    void Promise.all(done.map((t) => deleteTask(t.id))).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : 'Suppression impossible'),
    );
  };

  const selectedEpic = epicIds.has(draftEpic) ? draftEpic : '';
  const onComposerKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const order = ['llm', 'command'] as const;
    const index = order.indexOf(composer);
    const next = event.key === 'Home' ? 'llm' : event.key === 'End' ? 'command' : order[(index + (event.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length];
    setComposer(next);
    (next === 'llm' ? llmTab : commandTab).current?.focus();
  };
  const visible = (t: Task): boolean => showDone || t.status !== 'done';
  const loose = own.filter((t) => (t.epicId === null || !epicIds.has(t.epicId)) && visible(t));
  // Un epic entièrement terminé se range avec les tâches terminées.
  const shownEpics = ownEpics.filter((e) => {
    const members = own.filter((t) => t.epicId === e.id);
    return showDone || members.length === 0 || members.some((t) => t.status !== 'done');
  });
  const renderTask = (task: Task, index?: number) => (
    <TaskRow
      key={task.id}
      task={task}
      index={index}
      projectTasks={own}
      epics={ownEpics}
      session={sessions.find((s) => s.id === task.sessionId)}
      source={sessions.find((s) => s.id === task.sourceSessionId)}
      onStart={() => { if(task.execution?.type==='command') void api(`/api/tasks/${task.id}/start`,{method:'POST'}).catch(cause=>setError(String(cause))); else setStarting(task); }}
      onError={setError}
    />
  );

  return (
    <section className="card project-panel backlog">
      <div className="project-panel-head">
        <h2>Backlog <span className="pill project-panel-count" title="Tâches ouvertes">{open.length}</span></h2>
        <div className="row-actions">
          {done.length > 0 && showDone ? (
            <DelayedActionButton onAction={deleteDone}>Supprimer toutes les terminées</DelayedActionButton>
          ) : null}
          {done.length > 0 ? (
            <button type="button" className="btn" onClick={() => setShowDone((v) => !v)}>
              {showDone ? 'Masquer les terminées' : `Afficher les terminées (${done.length})`}
            </button>
          ) : null}
        </div>
      </div>
      <div className="task-composer">
        <div className="task-composer-tabs" role="tablist" aria-label="Création de tâche">
          <button
            ref={llmTab}
            type="button"
            role="tab"
            id={`task-tab-llm-${projectId}`}
            aria-selected={composer === 'llm'}
            aria-controls={`task-panel-llm-${projectId}`}
            tabIndex={composer === 'llm' ? 0 : -1}
            onClick={() => setComposer('llm')}
            onKeyDown={onComposerKey}
          >
            Avec agent
          </button>
          <button
            ref={commandTab}
            type="button"
            role="tab"
            id={`task-tab-command-${projectId}`}
            aria-selected={composer === 'command'}
            aria-controls={`task-panel-command-${projectId}`}
            tabIndex={composer === 'command' ? 0 : -1}
            onClick={() => setComposer('command')}
            onKeyDown={onComposerKey}
          >
            Commande
          </button>
        </div>
        <form
          id={`task-panel-llm-${projectId}`}
          role="tabpanel"
          aria-labelledby={`task-tab-llm-${projectId}`}
          hidden={composer !== 'llm'}
          className="task-add"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void add();
          }}
        >
          <textarea
            id={`task-draft-${projectId}`}
            rows={2}
            value={draft}
            placeholder={`Nouvelle tâche (${SUBMIT_HINT} pour ajouter)`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
              if (isSubmitShortcut(e)) {
                e.preventDefault();
                void add();
              }
            }}
          />
          <div className="task-add-actions">
            <EpicSelect epics={ownEpics} value={selectedEpic} onChange={setDraftEpic} />
            <button type="submit" className="btn primary" disabled={busy || draft.trim() === ''}>
              Ajouter
            </button>
            <button type="button" className="btn" onClick={() => setCreatingEpic((v) => !v)} aria-expanded={creatingEpic}>
              Nouvel epic
            </button>
          </div>
        </form>
        <CommandTasks
          projectId={projectId}
          hidden={composer !== 'command'}
          panelId={`task-panel-command-${projectId}`}
          labelledBy={`task-tab-command-${projectId}`}
          epicId={selectedEpic}
          epics={ownEpics}
          onEpicChange={setDraftEpic}
          creatingEpic={creatingEpic}
          onCreateEpic={() => setCreatingEpic((v) => !v)}
        />
      </div>
      {creatingEpic ? (
        <EpicForm
          submitLabel="Créer l'epic"
          onCancel={() => setCreatingEpic(false)}
          onSubmit={async (title, description) => {
            const epic = await createEpic(projectId, title, description);
            setDraftEpic(epic.id);
            setCreatingEpic(false);
          }}
        />
      ) : null}
      {shownEpics.map((epic) => (
        <EpicBlock
          key={epic.id}
          epic={epic}
          projectTasks={own}
          sessions={sessions}
          showDone={showDone}
          renderTask={renderTask}
          onStart={(prompt) => { const members=own.filter(t=>t.epicId===epic.id&&t.status!=='done');if(members.every(t=>t.execution?.type==='command'))void api(`/api/epics/${epic.id}/start`,{method:'POST',body:'{}'}).catch(cause=>setError(String(cause)));else setStartingEpic({ epic, prompt }); }}
          onError={setError}
        />
      ))}
      {shownEpics.length > 0 && loose.length > 0 ? <h3 className="backlog-loose">Sans epic</h3> : null}
      {loose.length === 0 && shownEpics.length === 0 ? (
        <p className="empty-hint">
          Aucune tâche. Sélectionnez du texte dans un terminal, ou demandez à l'agent de mettre ses findings dans le backlog.
        </p>
      ) : loose.length > 0 ? (
        <ul className="task-list">{loose.map((task) => renderTask(task))}</ul>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
      {starting ? (
        <LaunchSessionDialog
          title={`Traiter : ${taskTitle(starting.text).slice(0, 80)}`}
          projectId={projectId}
          initialPrompt={starting.text}
          onClose={() => setStarting(null)}
          onLaunch={async (spec) => {
            await startTask(starting.id, spec);
            setStarting(null);
          }}
        />
      ) : null}
      {startingEpic ? (
        <LaunchSessionDialog
          title={`Traiter l'epic : ${startingEpic.epic.title.slice(0, 80)}`}
          projectId={projectId}
          initialPrompt={startingEpic.prompt}
          onClose={() => setStartingEpic(null)}
          onLaunch={async (spec) => {
            await startEpic(startingEpic.epic.id, spec);
            setStartingEpic(null);
          }}
        />
      ) : null}
    </section>
  );
}

function EpicRunView({epicId}:{epicId:string}) {
  const [run,setRun]=useState<EpicRun|null>(null);const [error,setError]=useState<string|null>(null);
  const refresh=async():Promise<void>=>{const runs=await api<EpicRun[]>(`/api/epics/${epicId}/runs`);setRun(runs[0]??null);};
  useEffect(()=>{void refresh().catch(()=>{});const timer=window.setInterval(()=>void refresh().catch(()=>{}),1000);return()=>window.clearInterval(timer);},[epicId]);
  if(!run)return null;
  const action=(name:string):void=>{void api(`/api/epic-runs/${run.id}/${name}`,{method:'POST',body:JSON.stringify({replan:name==='resume'})}).then(()=>{setError(null);return refresh();}).catch(cause=>setError(String(cause)));};
  return <details onToggle={e=>{if(e.currentTarget.open&&run)void api(`/api/operations/${encodeURIComponent(`epic:${run.id}:${run.status}`)}/seen`,{method:'POST'}).catch(()=>{});}}><summary>Ordonnanceur : {run.status} — {Object.keys(run.results).length}/{run.order.length} résultats</summary>
    <p>Étape courante : {run.currentTaskId??'aucune'} — espace : {run.contextRoot}</p>
    {run.error?<p>{run.error}</p>:null}{Object.entries(run.results).map(([id,result])=><p key={id}>{id} : {result}</p>)}
    {['running','waiting-validation','blocked'].includes(run.status)?<button className="btn" onClick={()=>action('stop')}>Arrêter l’epic</button>:null}
    {['waiting-validation','blocked','failed','stopped'].includes(run.status)?<button className="btn" onClick={()=>action('resume')}>Reprendre et recalculer</button>:null}
    {error?<p className="form-error">{error}</p>:null}
  </details>;
}

const EMPTY_COMMAND = JSON.stringify({ name: '', executable: '', args: [], cwd: '.', timeoutSeconds: 300 }, null, 2);

function EpicSelect({ epics, value, onChange }: { epics: Epic[]; value: string; onChange: (id: string) => void }) {
  if (epics.length === 0) return null;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Epic de la tâche">
      <option value="">Sans epic</option>
      {epics.map((epic) => (
        <option key={epic.id} value={epic.id}>
          {epic.title.slice(0, 60)}
        </option>
      ))}
    </select>
  );
}

function CommandTasks({
  projectId,
  hidden,
  panelId,
  labelledBy,
  epicId,
  epics,
  onEpicChange,
  creatingEpic,
  onCreateEpic,
}: {
  projectId: string;
  hidden: boolean;
  panelId: string;
  labelledBy: string;
  epicId: string;
  epics: Epic[];
  onEpicChange: (id: string) => void;
  creatingEpic: boolean;
  onCreateEpic: () => void;
}) {
  const [commands, setCommands] = useState<ProjectCommand[]>([]);
  const [raw, setRaw] = useState(EMPTY_COMMAND);
  const [autoComplete, setAutoComplete] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current;
    try {
      const list = await api<ProjectCommand[]>(`/api/projects/${projectId}/commands`);
      if (loadGeneration.current !== generation) return;
      setCommands(list);
      setSelected((current) => (list.some((command) => command.id === current) ? current : ''));
      setLoaded(true);
    } catch (cause) {
      if (loadGeneration.current !== generation) return;
      setError(cause instanceof Error ? cause.message : 'Chargement des commandes impossible');
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    setLoaded(false);
    setCommands([]);
    setSelected('');
    setText('');
    setError(null);
    setRaw(EMPTY_COMMAND);
    void refresh();
  }, [refresh]);

  const add = (): void => {
    void api(`/api/projects/${projectId}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        epicId: epicId || null,
        execution: { type: 'command', commandId: selected, completion: autoComplete ? 'exit-zero' : 'manual' },
      }),
    })
      .then(() => {
        setText('');
        setError(null);
      })
      .catch((cause: unknown) => setError(String(cause)));
  };

  const saveCommand = (): void => {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch (cause) {
      setError(String(cause));
      return;
    }
    void api<ProjectCommand>(`/api/projects/${projectId}/commands`, { method: 'POST', body: JSON.stringify(body) })
      .then(async (command) => {
        setError(null);
        await refresh();
        setSelected(command.id);
      })
      .catch((cause: unknown) => setError(String(cause)));
  };

  const commandConfig = (
    <>
      <textarea rows={9} value={raw} onChange={(e) => setRaw(e.target.value)} aria-label="Configuration de la commande" spellCheck={false} />
      <button type="button" className="btn" onClick={saveCommand}>
        Enregistrer cette commande
      </button>
    </>
  );

  return (
    <form
      id={panelId}
      role="tabpanel"
      aria-labelledby={labelledBy}
      hidden={hidden}
      className="task-add"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        add();
      }}
    >
      {!loaded ? <p className="hint">Chargement des commandes…</p> : null}
      {commands.length > 0 ? (
        <select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Commande du projet">
          <option value="">Choisir une commande</option>
          {commands.map((command) => (
            <option key={command.id} value={command.id}>
              {command.name}
            </option>
          ))}
        </select>
      ) : null}
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Description de la tâche" aria-label="Description de la tâche" />
      <label className="task-command-check">
        <input type="checkbox" checked={autoComplete} onChange={(e) => setAutoComplete(e.target.checked)} />
        Dans un epic, clore automatiquement si le code de sortie vaut zéro
      </label>
      <div className="task-add-actions">
        <EpicSelect epics={epics} value={epicId} onChange={onEpicChange} />
        <button type="submit" className="btn primary" disabled={!selected || text.trim() === ''}>
          Ajouter
        </button>
        <button type="button" className="btn" onClick={onCreateEpic} aria-expanded={creatingEpic}>
          Nouvel epic
        </button>
      </div>
      {loaded && commands.length === 0 ? <div className="task-command-config">{commandConfig}</div> : null}
      {loaded && commands.length > 0 ? (
        <details className="task-command-config" key={commands.length}>
          <summary>Configurer une commande (JSON)</summary>
          {commandConfig}
        </details>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}
function CommandRunView({task,onActive}:{task:Task;onActive:(active:boolean)=>void}) {
  const detail=useRef<HTMLDetailsElement>(null);
  const [runs,setRuns]=useState<CommandRun[]>([]);
  useEffect(()=>{const refresh=async():Promise<void>=>{const runs=await api<CommandRun[]>(`/api/tasks/${task.id}/runs`);setRuns(runs);onActive(runs[0]?.status==='running');};void refresh().catch(()=>{});const timer=window.setInterval(()=>void refresh().catch(()=>{}),1000);return()=>window.clearInterval(timer);},[task.id]);
  const run=runs[0];
  useEffect(()=>{if(detail.current?.open&&run?.finishedAt)void api(`/api/operations/${encodeURIComponent(run.id)}/seen`,{method:'POST'}).catch(()=>{});},[run?.id,run?.finishedAt]);
  return <details ref={detail} onToggle={e=>{if(e.currentTarget.open&&run?.finishedAt)void api(`/api/operations/${encodeURIComponent(run.id)}/seen`,{method:'POST'}).catch(()=>{});}}><summary>Commande — {run?.status??'non exécutée'}{run?.status==='succeeded'&&task.status!=='done'?' ; travail à valider':''}</summary>
    {run?<><p>{run.command.executable} {JSON.stringify(run.command.args)} — {run.cwd}</p><p>Code : {run.exitCode??'—'} ; durée : {Math.floor(((run.finishedAt??Date.now())-run.startedAt)/1000)} s</p><pre>{run.output}</pre>{run.error?<p className="form-error">{run.error}</p>:null}{run.status==='running'?<button className="btn" onClick={()=>void api(`/api/command-runs/${run.id}/stop`,{method:'POST'})}>Arrêter la commande</button>:null}</>:null}
    <p className="hint">Un code de sortie nul décrit l’exécution. La clôture du travail reste une validation explicite.</p>
  </details>;
}

function EpicForm({
  initialTitle = '',
  initialDescription = '',
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialTitle?: string;
  initialDescription?: string;
  submitLabel: string;
  onSubmit: (title: string, description: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (busy || title.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(title, description);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enregistrement impossible');
      setBusy(false);
    }
  };

  return (
    <form
      className="epic-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        autoFocus
        value={title}
        placeholder="Titre de l'epic"
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        rows={3}
        value={description}
        placeholder="Contexte commun aux tâches (facultatif, transmis à la session qui traite l'epic)"
        onChange={(e) => setDescription(e.target.value)}
      />
      {error ? <p className="form-error">{error}</p> : null}
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={busy || title.trim() === ''}>
          {submitLabel}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}

function EpicBlock({
  epic,
  projectTasks,
  sessions,
  showDone,
  renderTask,
  onStart,
  onError,
}: {
  epic: Epic;
  projectTasks: Task[];
  sessions: Session[];
  showDone: boolean;
  renderTask: (task: Task, index?: number) => ReactNode;
  onStart: (prompt: string) => void;
  onError: (message: string) => void;
}) {
  const { updateEpic, deleteEpic } = useStore();
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState(false);
  const members = projectTasks.filter((t) => t.epicId === epic.id);
  const ordered = dependencyOrder(members);
  const open = ordered.filter((t) => t.status !== 'done');
  const doneCount = members.length - open.length;
  const byId = new Map(projectTasks.map((t) => [t.id, t]));
  const outsideBlockers = open.flatMap((t) => t.dependsOn).map((id) => byId.get(id))
    .filter((t): t is Task => t !== undefined && t.epicId !== epic.id && t.status !== 'done');
  const activeSession = open
    .map((t) => (t.status === 'started' ? sessions.find((s) => s.id === t.sessionId) : undefined))
    .find((s) => s !== undefined && s.status !== 'exited');
  const position = new Map(open.map((t, i) => [t.id, i + 1]));
  // Displayed in creation order; the number gives the processing rank (dependency order).
  const shown = showDone ? members : members.filter((t) => t.status !== 'done');
  const startHint = open.length === 0
    ? 'Aucune tâche ouverte dans cet epic'
    : outsideBlockers.length > 0
      ? `Attend des tâches hors de l'epic : ${outsideBlockers.map((t) => taskTitle(t.text).slice(0, 60)).join(' · ')}`
      : activeSession !== undefined
        ? 'Une session traite déjà cet epic'
        : `Le serveur ordonnance les ${open.length} tâche(s) selon leurs dépendances`;

  return (
    <div className="epic">
      <EpicRunView epicId={epic.id} />
      <div className="epic-head">
        <button type="button" className="epic-title" aria-expanded={!collapsed} onClick={() => setCollapsed((v) => !v)}>
          <span className="task-caret">{collapsed ? '▸' : '▾'}</span>
          <span className="epic-badge">Epic</span>
          <span>{epic.title}</span>
        </button>
        <div className="task-row-meta">
          <span className={`pill task-status ${members.length > 0 && open.length === 0 ? 'done' : ''}`}>
            {doneCount}/{members.length} terminée{doneCount > 1 ? 's' : ''}
          </span>
          <span className="epic-progress" aria-hidden="true">
            <span style={{ width: members.length === 0 ? 0 : `${(doneCount / members.length) * 100}%` }} />
          </span>
          {activeSession ? (
            <a className="task-session" href={href(`#/s/${activeSession.id}`)} title={STATUS_LABEL[activeSession.status]}>
              <StatusDot status={activeSession.status} title={STATUS_LABEL[activeSession.status]} />
              {sessionTitle(activeSession.title)}
            </a>
          ) : null}
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn primary"
            disabled={open.length === 0 || outsideBlockers.length > 0 || activeSession !== undefined}
            title={startHint}
            onClick={() => onStart(epicPrompt(epic, open))}
          >
            Traiter l'epic
          </button>
          <button type="button" className="btn" onClick={() => setEditing((v) => !v)}>
            Éditer
          </button>
          <DelayedActionButton
            onAction={() => void deleteEpic(epic.id).catch((err: unknown) => onError(err instanceof Error ? err.message : 'Suppression impossible'))}
          >
            Supprimer l'epic
          </DelayedActionButton>
        </div>
      </div>
      {editing ? (
        <EpicForm
          initialTitle={epic.title}
          initialDescription={epic.description}
          submitLabel="Enregistrer"
          onCancel={() => setEditing(false)}
          onSubmit={async (title, description) => {
            await updateEpic(epic.id, { title, description });
            setEditing(false);
          }}
        />
      ) : epic.description !== '' && !collapsed ? (
        <p className="epic-description">{epic.description}</p>
      ) : null}
      {collapsed ? null : shown.length === 0 ? (
        <p className="empty-hint">
          {members.length === 0
            ? 'Epic vide : rangez-y des tâches (menu « Epic » d\'une tâche, ou sélecteur sous le champ d\'ajout).'
            : 'Toutes les tâches sont terminées.'}
        </p>
      ) : (
        <ul className="task-list">{shown.map((task) => renderTask(task, position.get(task.id)))}</ul>
      )}
    </div>
  );
}

function TaskRow({
  task,
  index,
  projectTasks,
  epics,
  session,
  source,
  onStart,
  onError,
}: {
  task: Task;
  // Rang dans l'ordre de traitement de son epic.
  index?: number;
  projectTasks: Task[];
  epics: Epic[];
  session: Session | undefined;
  source: Session | undefined;
  onStart: () => void;
  onError: (message: string) => void;
}) {
  const { updateTask, deleteTask } = useStore();
  const [expanded, setExpanded] = useState(false);
  const [commandActive,setCommandActive]=useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.text);
  const byId = new Map(projectTasks.map((t) => [t.id, t]));
  const dependencies = task.dependsOn.map((id) => byId.get(id)).filter((t): t is Task => t !== undefined);
  const blockers = dependencies.filter((t) => t.status !== 'done');
  const pill = taskPill(task, session, blockers.length > 0);
  // Relancer pendant que la session tourne en démarrerait une seconde et détacherait la première.
  const sessionActive = task.status === 'started' && session !== undefined && session.status !== 'exited';
  const excluded = dependents(task.id, projectTasks);
  const candidates = projectTasks.filter((t) => t.id !== task.id && !task.dependsOn.includes(t.id) && !excluded.has(t.id));
  const setDependencies = (dependsOn: string[]): void => {
    run(() => updateTask(task.id, { dependsOn }), 'Modification des dépendances impossible');
  };

  const run = (fn: () => Promise<unknown>, fallback: string): void => {
    void fn().catch((err: unknown) => onError(err instanceof Error ? err.message : fallback));
  };

  const save = (): void => {
    if (draft.trim() === '') return;
    run(async () => {
      await updateTask(task.id, { text: draft });
      setEditing(false);
    }, 'Modification impossible');
  };

  return (
    <li className={`task-row ${task.status}`}>
      <div className="task-row-main">
        <button
          type="button"
          className="task-title"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="task-caret">{expanded ? '▾' : '▸'}</span>
          {index !== undefined ? <span className="task-index">{index}.</span> : null}
          <span>{taskTitle(task.text)}</span>
        </button>
        <div className="task-row-meta">
          <span className={`pill task-status ${pill.className}`}>{pill.label}</span>
          {session ? (
            <a className="task-session" href={href(`#/s/${session.id}`)} title={STATUS_LABEL[session.status]}>
              <StatusDot status={session.status} title={STATUS_LABEL[session.status]} />
              {sessionTitle(session.title)}
            </a>
          ) : null}
          {blockers.length > 0 && task.status !== 'done' ? (
            <span className="task-blockers">
              Attend : {blockers.map((t) => taskTitle(t.text).slice(0, 60)).join(' · ')}
            </span>
          ) : null}
        </div>
      </div>
      <div className="row-actions">
        {task.status !== 'done' && !sessionActive && !commandActive ? (
          <button
            type="button"
            className="btn primary"
            onClick={onStart}
            disabled={blockers.length > 0}
            title={blockers.length > 0 ? 'Terminez d\'abord les tâches dont celle-ci dépend' : undefined}
          >
            {task.status === 'started' ? 'Relancer' : 'Traiter'}
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          onClick={() => run(() => updateTask(task.id, { status: task.status === 'done' ? 'todo' : 'done' }), 'Modification impossible')}
        >
          {task.status === 'done' ? 'Rouvrir' : 'Marquer terminée'}
        </button>
        <DelayedActionButton onAction={() => run(() => deleteTask(task.id), 'Suppression impossible')}>
          Supprimer
        </DelayedActionButton>
      </div>
      {task.execution?.type==='command' ? <CommandRunView task={task} onActive={setCommandActive} /> : null}
      {expanded ? (
        <div className="task-detail">
          {editing ? (
            <>
              <textarea rows={10} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
              <div className="row-actions">
                <button type="button" className="btn primary" disabled={draft.trim() === ''} onClick={save}>
                  Enregistrer
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setDraft(task.text);
                    setEditing(false);
                  }}
                >
                  Annuler
                </button>
              </div>
            </>
          ) : (
            <>
              <pre className="task-text">{task.text}</pre>
              <div className="task-deps">
                <span className="meta">Dépend de :</span>
                {dependencies.length === 0 ? <span className="meta">aucune tâche</span> : null}
                {dependencies.map((dep) => (
                  <span key={dep.id} className={`task-dep ${dep.status}`}>
                    {taskTitle(dep.text).slice(0, 60)}
                    <button
                      type="button"
                      className="task-dep-remove"
                      aria-label="Retirer la dépendance"
                      onClick={() => setDependencies(task.dependsOn.filter((id) => id !== dep.id))}
                    >
                      ×
                    </button>
                  </span>
                ))}
                {candidates.length > 0 ? (
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value !== '') setDependencies([...task.dependsOn, e.target.value]);
                    }}
                  >
                    <option value="">Ajouter une dépendance…</option>
                    {candidates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {taskTitle(t.text).slice(0, 80)}
                        {t.status === 'done' ? ' (terminée)' : ''}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
              {epics.length > 0 ? (
                <div className="task-deps">
                  <span className="meta">Epic :</span>
                  <select
                    value={task.epicId ?? ''}
                    onChange={(e) =>
                      run(() => updateTask(task.id, { epicId: e.target.value === '' ? null : e.target.value }), 'Changement d\'epic impossible')
                    }
                  >
                    <option value="">Sans epic</option>
                    {epics.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.title.slice(0, 80)}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div className="row-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setDraft(task.text);
                    setEditing(true);
                  }}
                >
                  Éditer
                </button>
                {source ? (
                  <a className="meta" href={href(`#/s/${source.id}`)}>
                    Issue de « {sessionTitle(source.title)} »
                  </a>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}
