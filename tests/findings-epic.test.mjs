import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-findings-epic-'));
process.env.CEREBRO_DATA_DIR = root;
const { CerebroDatabase } = await import('../server/db.ts');
const { importFindings, listReports, saveReport } = await import('../server/findings.ts');
after(() => rmSync(root, { recursive: true, force: true }));

const finding = (id, dependsOn = []) => ({
  id,
  title: `Bug ${id}`,
  severity: 'high',
  file: 'server/file.ts',
  line: 12,
  problem: 'Valeur non vérifiée',
  scenario: 'Entrée vide',
  expectedFix: 'Valider la valeur',
  dependsOn,
  taskDependencies: [],
});
function fixture(run) {
  const path = join(root, `${randomUUID()}.db`);
  const db = new CerebroDatabase(path);
  const project = db.createProject('Projet', root);
  const epic = db.createEpic(project.id, 'Livraison', '', null);
  const work = db.createTask(project.id, 'Implémentation', null, epic.id);
  db.updateTask(work.id, { status: 'done' });
  const review = db.createTask(project.id, 'Review', null, epic.id);
  const session = db.createSession(
    {
      id: randomUUID(),
      projectId: project.id,
      agent: 'codex',
      mode: 'auto',
      model: null,
      effort: null,
      prompt: 'Review de l’epic',
      title: 'Review',
      status: 'exited',
      agentSessionId: 'fake',
    },
    'token',
    epic.id,
  );
  try {
    run({ db, path, project, epic, work, review, session });
  } finally {
    db.close();
  }
}

test('epic review findings append to the source epic after every existing step', () =>
  fixture((f) => {
    const report = saveReport(f.db, f.session.id, { title: 'Findings', findings: [finding('a'), finding('b', ['a'])] });
    const result = importFindings(f.db, f.session.id, report.id, ['b', 'a']);
    assert.equal(result.epic.id, f.epic.id);
    assert.equal(f.db.listEpics().length, 1);
    assert.deepEqual(
      f.db.listTasks().map((task) => task.id),
      [f.work.id, f.review.id, ...result.tasks.map((task) => task.id)],
    );
    const a = result.tasks.find((task) => task.id === result.imported.a);
    const b = result.tasks.find((task) => task.id === result.imported.b);
    assert.deepEqual(a.dependsOn.slice().sort(), [f.work.id, f.review.id].sort());
    assert.deepEqual(b.dependsOn.slice().sort(), [f.work.id, f.review.id, a.id].sort());
    assert.equal(a.status, 'todo');
    assert.equal(a.sourceSessionId, f.session.id);
    assert.match(a.text, /server\/file.ts:12/);
    assert.equal(f.db.getTask(f.review.id).status, 'todo');
    assert.equal(listReports(f.db, f.session.id)[0].epicId, f.epic.id);
  }));

test('partial imports keep their destination and dependencies after restart without duplicating tasks', () =>
  fixture((f) => {
    const report = saveReport(f.db, f.session.id, {
      title: 'Findings',
      findings: [finding('a'), finding('b', ['a']), finding('c')],
    });
    assert.throws(() => importFindings(f.db, f.session.id, report.id, ['b']), /prérequis/);
    const first = importFindings(f.db, f.session.id, report.id, ['a'], f.epic.id);
    const reopened = new CerebroDatabase(f.path);
    try {
      const second = importFindings(reopened, f.session.id, report.id, ['a', 'b', 'c']);
      assert.equal(second.epic.id, f.epic.id);
      assert.equal(second.tasks.length, 2);
      assert.ok(reopened.getTask(second.imported.b).dependsOn.includes(first.imported.a));
      assert.ok(!reopened.getTask(second.imported.c).dependsOn.includes(first.imported.a));
      assert.equal(importFindings(reopened, f.session.id, report.id, ['a', 'b', 'c'], f.epic.id).tasks.length, 0);
      const other = reopened.createEpic(f.project.id, 'Autre', '', null);
      assert.throws(() => importFindings(reopened, f.session.id, report.id, ['a'], other.id), /déjà été importé/);
      assert.equal(reopened.listTasks().length, 5);
    } finally {
      reopened.close();
    }
  }));

test('an epic review can explicitly create a new epic and keep using it on later imports', () =>
  fixture((f) => {
    const report = saveReport(f.db, f.session.id, { title: 'Autre epic', findings: [finding('a'), finding('b')] });
    const first = importFindings(f.db, f.session.id, report.id, ['a'], null);
    assert.notEqual(first.epic.id, f.epic.id);
    assert.deepEqual(first.tasks[0].dependsOn, []);
    assert.equal(importFindings(f.db, f.session.id, report.id, ['a'], null).tasks.length, 0);
    const second = importFindings(f.db, f.session.id, report.id, ['b']);
    assert.equal(second.epic.id, first.epic.id);
    assert.deepEqual(second.tasks[0].dependsOn, []);
    assert.equal(f.db.listEpics().length, 2);
  }));

test('missing, foreign or invalid epic destinations leave no tasks or import markers', () =>
  fixture((f) => {
    const otherProject = f.db.createProject('Autre projet', root);
    const foreign = f.db.createEpic(otherProject.id, 'Livraison', '', null);
    const report = saveReport(f.db, f.session.id, { title: 'Findings', findings: [finding('a')] });
    for (const destination of ['missing', foreign.id, '', true, {}]) {
      assert.throws(() => importFindings(f.db, f.session.id, report.id, ['a'], destination));
      assert.equal(f.db.listTasks().length, 2);
      assert.equal(f.db.listEpics().length, 2);
      assert.deepEqual(listReports(f.db, f.session.id)[0].imported, {});
      assert.equal(listReports(f.db, f.session.id)[0].epicId, null);
    }
    f.db.deleteEpic(f.epic.id);
    assert.throws(() => importFindings(f.db, f.session.id, report.id, ['a']), /supprimé/);
    assert.equal(f.db.listEpics().length, 1);
    const replacement = importFindings(f.db, f.session.id, report.id, ['a'], null);
    f.db.deleteEpic(replacement.epic.id);
    assert.throws(() => importFindings(f.db, f.session.id, report.id, ['a']), /supprimé/);
    assert.equal(f.db.listTasks().length, 3);
  }));
