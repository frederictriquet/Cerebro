import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-epic-'));
process.env.CEREBRO_DATA_DIR = root;
const { CerebroDatabase, DEFAULT_SESSION_DEFAULTS } = await import('../server/db.ts');
const { CommandExecutor } = await import('../server/commands.ts');
const { EpicRunner, taskOrder } = await import('../server/epic-runner.ts');
async function fixture(run) {
  const db = new CerebroDatabase(':memory:');
  const project = db.createProject('Demo', root);
  const epic = db.createEpic(project.id, 'Epic', 'Context', null);
  const commands = new CommandExecutor(db);
  const launches = [];
  const sessions = {
    async create(p, options, validate, contextPath, title = 'step') {
      const session = db.createSession(
        { id: randomUUID(), projectId: p.id, ...options, title, status: 'idle', agentSessionId: 'fake' },
        'token',
      );
      launches.push(session);
      return session;
    },
    kill(id) {
      db.updateSession(id, { status: 'exited', exitCode: 130 });
      return true;
    },
  };
  let runner = new EpicRunner(db, sessions, commands, () => {});
  const task = (name, execution = { type: 'llm' }) => db.createTask(project.id, name, null, epic.id, execution);
  const command = (script, completion = 'manual') => {
    const c = commands.configure(project.id, {
      name: 'check',
      executable: process.execPath,
      args: ['-e', script],
      cwd: '.',
      timeoutSeconds: 5,
    });
    return { type: 'command', commandId: c.id, completion };
  };
  const latest = () => runner.list(epic.id)[0];
  const until = async (predicate) => {
    for (let i = 0; i < 1000; i++) {
      runner.poke();
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`Timed out: ${JSON.stringify(latest())}`);
  };
  try {
    await run({
      db,
      project,
      epic,
      commands,
      sessions,
      launches,
      task,
      command,
      latest,
      until,
      get runner() {
        return runner;
      },
      restart: async () => {
        await runner.shutdown();
        runner = new EpicRunner(db, sessions, commands, () => {});
      },
    });
  } finally {
    await runner.shutdown();
    await commands.shutdown();
    db.close();
  }
}
test('mixed epic advances only on applicable explicit criteria; future tasks remain todo', async () =>
  fixture(async (f) => {
    const a = f.task('command auto', f.command('console.log("a")', 'exit-zero'));
    const b = f.task('reasoning');
    const c = f.task('command manual', f.command('console.log("c")'));
    const d = f.task('last', f.command('console.log("d")', 'exit-zero'));
    f.db.setTaskDependencies(b.id, [a.id]);
    f.db.setTaskDependencies(c.id, [b.id]);
    f.db.setTaskDependencies(d.id, [c.id]);
    f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS);
    assert.throws(() => f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS), /déjà/);
    await f.until(() => f.latest().status === 'waiting-validation' && f.latest().currentTaskId === b.id);
    assert.equal(f.db.getTask(a.id).status, 'done');
    assert.equal(f.db.getTask(b.id).status, 'started');
    assert.equal(f.db.getTask(c.id).status, 'todo');
    assert.equal(f.launches.length, 1);
    f.db.updateTask(b.id, { status: 'done' });
    await f.until(() => f.latest().status === 'waiting-validation' && f.latest().currentTaskId === c.id);
    assert.equal(f.db.getTask(d.id).status, 'todo');
    assert.equal(f.db.getTask(c.id).status, 'started');
    f.db.updateTask(c.id, { status: 'done' });
    await f.until(() => f.latest().status === 'succeeded');
    assert.equal(f.launches.length, 1);
  }));
test('failed prerequisite stops independent and dependent future tasks', async () =>
  fixture(async (f) => {
    const a = f.task('fail', f.command('process.exit(4)', 'exit-zero'));
    const b = f.task('dependent');
    f.db.setTaskDependencies(b.id, [a.id]);
    const c = f.task('independent');
    f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS);
    await f.until(() => f.latest().status === 'failed');
    assert.equal(f.db.getTask(b.id).status, 'todo');
    assert.equal(f.db.getTask(c.id).status, 'todo');
    assert.equal(f.launches.length, 0);
  }));
test('restart and interrupted/idle LLM turns never imply done; --done equivalent advances', async () =>
  fixture(async (f) => {
    const a = f.task('first');
    const b = f.task('next');
    f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS);
    await f.until(() => f.latest().status === 'waiting-validation');
    await f.restart();
    await f.until(() => f.latest().status === 'waiting-validation');
    assert.equal(f.launches.length, 1);
    assert.equal(f.db.getTask(b.id).status, 'todo');
    const session = f.db.getTask(a.id).sessionId;
    f.db.updateSession(session, { status: 'exited', exitCode: 130 });
    await f.until(() => f.latest().status === 'failed');
    assert.equal(f.db.getTask(a.id).status, 'started');
  }));
test('external prerequisites and backlog mutations block explicitly; stop/resume is deliberate', async () =>
  fixture(async (f) => {
    const external = f.db.createTask(f.project.id, 'external', null);
    const a = f.task('first');
    f.db.setTaskDependencies(a.id, [external.id]);
    assert.throws(() => f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS), /hors epic/);
    f.db.updateTask(external.id, { status: 'done' });
    f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS);
    await f.until(() => f.latest().status === 'waiting-validation');
    f.task('new');
    await f.until(() => f.latest().status === 'blocked');
    assert.match(f.latest().error, /Composition/);
    await f.runner.stop(f.latest().id);
    assert.equal(f.latest().status, 'stopped');
    await new Promise((r) => setTimeout(r, 10));
    f.runner.resume(f.latest().id, true);
    await f.until(() => f.latest().status === 'waiting-validation');
    assert.equal(f.latest().order.length, 2);
  }));
test('server topological order detects cycles', () => {
  const a = { id: 'a', dependsOn: ['b'], status: 'todo' },
    b = { id: 'b', dependsOn: ['a'], status: 'todo' };
  assert.throws(() => taskOrder([a, b], [a, b]), /Cycle/);
});
test('replanning includes added tasks but preserves explicit validation requirements until the current task is done', async () =>
  fixture(async (f) => {
    const a = f.task('deploy and verify');
    const b = f.task('next');
    f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS);
    await f.until(() => f.latest().status === 'waiting-validation');
    const first = f.launches[0];
    const reason = 'MR ready; merge, deploy and verify the scheduled export before closing.';
    f.db.updateSession(first.id, { attentionReason: 'Tour terminé' });
    f.runner.report(first.id, a.id, 'waiting-validation', reason);
    // Repeated ticks and a restart must not erase the agent's criteria.
    for (let i = 0; i < 3; i++) {
      f.runner.poke();
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(f.latest().error, reason);
    }
    await f.restart();
    f.runner.poke();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(f.latest().error, reason);
    const added = f.task('added while running');
    await f.until(() => f.latest().status === 'blocked');
    await new Promise((r) => setTimeout(r, 5));
    f.runner.resume(f.latest().id, true);
    await f.until(() => f.latest().status === 'waiting-validation');
    assert.equal(f.latest().error, reason);
    assert.ok(f.latest().order.includes(added.id));
    assert.equal(f.latest().currentTaskId, a.id);
    assert.equal(f.db.getTask(a.id).status, 'started');
    assert.equal(f.launches.length, 1);
    f.db.updateTask(a.id, { status: 'done' });
    await f.until(() => f.latest().status === 'waiting-validation' && f.latest().currentTaskId === b.id);
    assert.equal(f.db.getSession(first.id).status, 'exited');
    assert.equal(f.latest().validationReason, null);
    assert.notEqual(f.latest().error, reason);
    assert.equal(f.db.getTask(added.id).status, 'todo');
    f.db.updateTask(b.id, { status: 'done' });
    await f.until(() => f.latest().currentTaskId === added.id && f.latest().status === 'waiting-validation');
    f.db.updateTask(added.id, { status: 'done' });
    await f.until(() => f.latest().status === 'succeeded');
  }));
test('LLM steps get a readable title and a declared-done step frees its terminal', async () =>
  fixture(async (f) => {
    const a = f.task('first step\nmore details');
    const b = f.task('second step');
    f.db.setTaskDependencies(b.id, [a.id]);
    f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS);
    await f.until(() => f.latest().status === 'waiting-validation');
    const first = f.launches[0];
    assert.equal(first.title, 'Epic « Epic » · étape 1/2 : first step');
    assert.match(first.prompt, /^\[CEREBRO_EPIC_STEP /);
    f.db.updateTask(a.id, { status: 'done' });
    await f.until(() => f.latest().status === 'waiting-validation' && f.latest().currentTaskId === b.id);
    assert.equal(f.db.getSession(first.id).status, 'exited');
    assert.equal(f.launches[1].title, 'Epic « Epic » · étape 2/2 : second step');
    assert.notEqual(f.db.getSession(f.launches[1].id).status, 'exited');
  }));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
test('stop during asynchronous LLM preparation cannot be overwritten by its launch callback', async () =>
  fixture(async (f) => {
    const a = f.task('slow');
    let release;
    let beforeLaunch;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    f.sessions.create = async (p, options, validate) => {
      const s = f.db.createSession(
        { id: randomUUID(), projectId: p.id, ...options, title: 'slow', status: 'starting', agentSessionId: 'fake' },
        'token',
      );
      beforeLaunch = validate;
      await gate;
      try {
        await validate();
      } catch (cause) {
        f.db.updateSession(s.id, { status: 'exited', exitCode: 1 });
        throw cause;
      }
      return s;
    };
    f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS);
    await f.until(() => !!beforeLaunch);
    await f.runner.stop(f.latest().id);
    release();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(f.latest().status, 'stopped');
    assert.equal(f.db.listSessions()[0].status, 'exited');
  }));
test('a brief wait of the step session does not block; a lasting wait or an explicit question does', async () =>
  fixture(async (f) => {
    const a = f.task('first');
    f.sessions.create = async (p, options, validate, contextPath, title = 'step') => {
      const s = f.db.createSession(
        { id: randomUUID(), projectId: p.id, ...options, title, status: 'running', agentSessionId: 'fake' },
        'token',
      );
      f.launches.push(s);
      return s;
    };
    const settle = async () => {
      for (let i = 0; i < 20; i++) {
        f.runner.poke();
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS);
    await f.until(() => f.launches.length === 1 && f.latest().sessionId === f.launches[0].id);
    const id = f.launches[0].id;
    f.db.updateSession(id, { status: 'waiting', attentionReason: 'Confirmation requise' });
    await settle();
    assert.equal(f.latest().status, 'running');
    f.db.updateSession(id, { status: 'running', attentionReason: null });
    await settle();
    assert.equal(f.latest().status, 'running');
    assert.equal(f.latest().waitingSince, null);
    f.runner.waitingGraceMs = 50;
    f.db.updateSession(id, { status: 'waiting', attentionReason: 'Confirmation requise' });
    await f.until(() => f.latest().status === 'blocked');
    assert.equal(f.latest().error, 'Confirmation requise');
    f.db.updateSession(id, { status: 'running', attentionReason: null });
    await new Promise((r) => setTimeout(r, 10));
    f.runner.resume(f.latest().id);
    f.runner.waitingGraceMs = 60_000;
    await settle();
    assert.equal(f.latest().status, 'running');
    f.db.updateSession(id, { status: 'waiting', attentionReason: 'Question : quelle base ?' });
    await f.until(() => f.latest().status === 'blocked');
    assert.equal(f.latest().error, 'Question : quelle base ?');
    assert.equal(f.db.getTask(a.id).status, 'started');
  }));
test('a run blocked by its step session resumes by itself once the cause is gone; other blocks stay', async () =>
  fixture(async (f) => {
    const a = f.task('first');
    const b = f.task('second');
    f.db.setTaskDependencies(b.id, [a.id]);
    f.sessions.create = async (p, options, validate, contextPath, title = 'step') => {
      const s = f.db.createSession(
        { id: randomUUID(), projectId: p.id, ...options, title, status: 'running', agentSessionId: 'fake' },
        'token',
      );
      f.launches.push(s);
      return s;
    };
    const settle = async () => {
      for (let i = 0; i < 20; i++) {
        f.runner.poke();
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    f.runner.waitingGraceMs = 0;
    f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS);
    await f.until(() => f.launches.length === 1 && f.latest().sessionId === f.launches[0].id);
    const first = f.launches[0].id;
    f.db.updateSession(first, { status: 'waiting', attentionReason: 'Confirmation requise' });
    await f.until(() => f.latest().status === 'blocked');
    assert.equal(f.latest().blockReason, 'session-waiting');
    await settle();
    assert.equal(f.latest().status, 'blocked');
    assert.equal(f.launches.length, 1);
    f.db.updateTask(a.id, { status: 'done' });
    await f.until(
      () => f.latest().status === 'running' && f.latest().currentTaskId === b.id && f.launches.length === 2,
    );
    assert.equal(f.latest().error, null);
    assert.equal(f.latest().blockReason, null);
    assert.equal(f.db.getSession(first).status, 'exited');
    // An explicit question keeps the run blocked even when the task is done, and a stopped run is never revived.
    const second = f.launches[1].id;
    f.db.updateSession(second, { status: 'waiting', attentionReason: 'Question : quelle base ?' });
    await f.until(() => f.latest().status === 'blocked');
    f.db.updateTask(b.id, { status: 'done' });
    await settle();
    assert.equal(f.latest().status, 'blocked');
    await f.runner.stop(f.latest().id);
    f.db.updateSession(second, { status: 'running', attentionReason: null });
    await settle();
    assert.equal(f.latest().status, 'stopped');
  }));
test('a run blocked by its step session resumes when the session runs again', async () =>
  fixture(async (f) => {
    const a = f.task('first');
    f.sessions.create = async (p, options, validate, contextPath, title = 'step') => {
      const s = f.db.createSession(
        { id: randomUUID(), projectId: p.id, ...options, title, status: 'running', agentSessionId: 'fake' },
        'token',
      );
      f.launches.push(s);
      return s;
    };
    f.runner.waitingGraceMs = 0;
    f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS);
    await f.until(() => f.launches.length === 1 && f.latest().sessionId === f.launches[0].id);
    const id = f.launches[0].id;
    f.db.updateSession(id, { status: 'waiting', attentionReason: 'Confirmation requise' });
    await f.until(() => f.latest().status === 'blocked');
    f.db.updateSession(id, { status: 'running', attentionReason: null });
    await f.until(() => f.latest().status === 'running');
    assert.equal(f.latest().error, null);
    assert.equal(f.latest().currentTaskId, a.id);
    f.db.updateSession(id, { status: 'idle', attentionReason: null });
    await f.until(() => f.latest().status === 'waiting-validation');
  }));
test('auto validation closes the waiting step and subsequent manual commands, and is recorded separately', async () =>
  fixture(async (f) => {
    const a = f.task('review');
    const b = f.task('manual command', f.command('process.exit(0)'));
    f.db.setTaskDependencies(b.id, [a.id]);
    f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS);
    await f.until(() => f.latest().status === 'waiting-validation');
    assert.equal(f.latest().autoValidate, false);
    assert.equal(f.db.getTask(a.id).status, 'started');
    f.runner.report(f.launches[0].id, a.id, 'waiting-validation', 'Validation demandée');
    f.runner.setAutoValidate(f.latest().id, true);
    await f.until(() => f.latest().status === 'succeeded');
    assert.equal(f.db.getTask(a.id).status, 'done');
    assert.equal(f.db.getTask(b.id).status, 'done');
    assert.equal(f.latest().results[a.id], 'auto-validated');
    assert.equal(f.latest().results[b.id], 'auto-validated');
    assert.throws(() => f.runner.setAutoValidate(f.latest().id, false), /plus en cours/);
  }));
test('auto validation persists through restart and can be disabled before the turn ends', async () =>
  fixture(async (f) => {
    const a = f.task('work');
    f.sessions.create = async (p, options) => {
      const s = f.db.createSession(
        { id: randomUUID(), projectId: p.id, ...options, title: 'work', status: 'running', agentSessionId: 'fake' },
        'token',
      );
      f.launches.push(s);
      return s;
    };
    f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS);
    await f.until(() => !!f.latest().sessionId);
    f.runner.setAutoValidate(f.latest().id, true);
    await f.restart();
    assert.equal(f.latest().autoValidate, true);
    f.runner.poke();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(f.db.getTask(a.id).status, 'started');
    assert.equal(f.latest().status, 'running');
    f.runner.setAutoValidate(f.latest().id, false);
    f.db.updateSession(f.launches[0].id, { status: 'idle' });
    await f.until(() => f.latest().status === 'waiting-validation');
    assert.equal(f.db.getTask(a.id).status, 'started');
  }));
test('auto validation leaves questions, explicit blocks, and failed sessions unresolved', async () =>
  fixture(async (f) => {
    const a = f.task('work');
    f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS);
    await f.until(() => f.latest().status === 'waiting-validation');
    const sid = f.launches[0].id;
    f.db.updateSession(sid, { status: 'waiting', attentionReason: 'Question : quel environnement ?' });
    f.runner.setAutoValidate(f.latest().id, true);
    await f.until(() => f.latest().status === 'blocked');
    assert.equal(f.db.getTask(a.id).status, 'started');
    f.runner.report(sid, a.id, 'blocked', 'Service indisponible');
    f.db.updateSession(sid, { status: 'idle', attentionReason: null });
    f.runner.poke();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(f.latest().status, 'blocked');
    assert.equal(f.db.getTask(a.id).status, 'started');
    f.db.updateSession(sid, { status: 'running' });
    f.runner.resume(f.latest().id);
    f.db.updateSession(sid, { status: 'exited', exitCode: 1 });
    await f.until(() => f.latest().status === 'failed');
    assert.equal(f.db.getTask(a.id).status, 'started');
  }));
test('auto validation does not accept failed commands', async () =>
  fixture(async (f) => {
    const a = f.task('failed command', f.command('process.exit(4)'));
    f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS);
    f.runner.setAutoValidate(f.latest().id, true);
    await f.until(() => f.latest().status === 'failed');
    assert.equal(f.db.getTask(a.id).status, 'started');
  }));
test('changing auto validation during asynchronous preparation survives launch completion', async () =>
  fixture(async (f) => {
    const a = f.task('slow');
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    f.sessions.create = async (p, options, validate) => {
      const s = f.db.createSession(
        { id: randomUUID(), projectId: p.id, ...options, title: 'slow', status: 'starting', agentSessionId: 'fake' },
        'token',
      );
      f.launches.push(s);
      await gate;
      await validate();
      f.db.updateSession(s.id, { status: 'idle' });
      return f.db.getSession(s.id);
    };
    f.runner.start(f.epic.id, DEFAULT_SESSION_DEFAULTS);
    try {
      await f.until(() => f.launches.length === 1);
      f.runner.setAutoValidate(f.latest().id, true);
    } finally {
      release();
    }
    await f.until(() => f.latest().status === 'succeeded');
    assert.equal(f.latest().autoValidate, true);
    assert.equal(f.db.getTask(a.id).status, 'done');
  }));
