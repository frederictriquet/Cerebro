import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-findings-visibility-'));
process.env.CEREBRO_DATA_DIR = root;
const { CerebroDatabase } = await import('../server/db.ts');
const { SessionManager } = await import('../server/sessions.ts');
const { importFindings, saveReport } = await import('../server/findings.ts');
const { parseEventsMessage, parseSession } = await import('../web/src/types.ts');
const { isAwaiting, isDormant, needsAttention } = await import('../web/src/format.ts');
const { parseHash, parseMachine } = await import('../web/src/route.ts');
const { showFindingsNotification, updateAttentionIndicators } = await import('../web/src/notify.ts');
after(() => rmSync(root, { recursive: true, force: true }));

const finding = id => ({ id, title: `Bug ${id}`, severity: 'high', file: 'file.ts', line: 1, problem: 'Valeur incorrecte', scenario: 'Entrée vide', expectedFix: 'Valider la valeur' });
function createSession(db, project) {
  return db.createSession({ id: randomUUID(), projectId: project.id, agent: 'codex', mode: 'auto', model: null, effort: null, prompt: '', title: 'Review', status: 'exited', agentSessionId: 'fake' }, 'token');
}

test('all session lists expose existing unimported findings across viewing, partial imports and restart', () => {
  const path = join(root, 'persist.db');
  let db = new CerebroDatabase(path);
  try {
    const project = db.createProject('Demo', root);
    const session = createSession(db, project);
    const other = createSession(db, project);
    assert.equal(session.pendingFindings, 0);
    const payload = { title: 'Review', findings: [finding('a'), finding('b')] };
    const report = saveReport(db, session.id, payload);
    saveReport(db, session.id, payload);
    const followup = saveReport(db, session.id, { title: 'Suite', findings: [finding('c')] });
    assert.equal(db.getSession(session.id).pendingFindings, 3);
    assert.equal(db.listSessions().find(item => item.id === session.id).pendingFindings, 3);
    assert.equal(db.listProjectSessions(project.id).find(item => item.id === session.id).pendingFindings, 3);
    assert.equal(db.getSession(other.id).pendingFindings, 0);
    const manager = new SessionManager(db);
    manager.seen(session.id);
    assert.equal(db.getSession(session.id).pendingFindings, 3);
    assert.equal(needsAttention(db.getSession(session.id)), true);
    assert.equal(isAwaiting(db.getSession(session.id)), false, 'findings do not imply a terminal awaiting input');
    importFindings(db, session.id, report.id, ['a']);
    assert.equal(db.getSession(session.id).pendingFindings, 2);
    db.close(); db = new CerebroDatabase(path);
    assert.equal(db.getSession(session.id).pendingFindings, 2);
    importFindings(db, session.id, report.id, ['a', 'b']);
    assert.equal(db.getSession(session.id).pendingFindings, 1);
    importFindings(db, session.id, followup.id, ['c']);
    assert.equal(db.getSession(session.id).pendingFindings, 0);
    assert.equal(db.listSessions().find(item => item.id === session.id).pendingFindings, 0);
    assert.equal(db.listProjectSessions(project.id).find(item => item.id === session.id).pendingFindings, 0);
    assert.equal(needsAttention(db.getSession(session.id)), false);
  } finally { db.close(); }
});

test('a review with pending findings stays visible and is excluded from the dormant-session purge', async t => {
  const db = new CerebroDatabase(':memory:');
  try {
    const project = db.createProject('Demo', root);
    const review = createSession(db, project);
    const ordinary = createSession(db, project);
    const report = saveReport(db, review.id, { title: 'Review', findings: [finding('a')] });
    db.connection.exec('UPDATE sessions SET updated_at = 0');
    const manager = new SessionManager(db);
    const deleted = [];
    t.mock.method(manager, 'delete', async id => { deleted.push(id); return db.deleteSession(id); });
    assert.equal(isDormant(db.getSession(review.id), Date.now()), false);
    assert.equal(await manager.purgeProject(project.id), 1);
    assert.deepEqual(deleted, [ordinary.id]);
    assert.ok(db.getSession(review.id));
    importFindings(db, review.id, report.id, ['a']);
    assert.equal(needsAttention(db.getSession(review.id)), false);
    assert.equal(await manager.purgeProject(project.id), 1);
    assert.equal(db.getSession(review.id), null);
  } finally { db.close(); }
});

test('pending counts and their events parse safely while older machines default to no findings', () => {
  const db = new CerebroDatabase(':memory:');
  try {
    const project = db.createProject('Demo', root);
    const session = createSession(db, project);
    assert.equal(parseSession({ ...session, pendingFindings: 4 }).pendingFindings, 4);
    for (const value of [undefined, null, -1, 1.5, '4', Infinity]) {
      assert.equal(parseSession({ ...session, pendingFindings: value }).pendingFindings, 0);
    }
    const event = parseEventsMessage({ type: 'findings-available', session: { ...session, pendingFindings: 4 } });
    assert.equal(event.type, 'findings-available');
    assert.equal(event.session.pendingFindings, 4);
    assert.equal(parseEventsMessage({ type: 'findings-available', session: {} }), null);
  } finally { db.close(); }
});

test('findings links target the session drawer locally and through another machine', () => {
  assert.deepEqual(parseHash('#/s/review/findings'), { kind: 'session', sessionId: 'review', panel: 'findings' });
  assert.deepEqual(parseHash('#/m/remote/s/review/findings'), { kind: 'session', sessionId: 'review', panel: 'findings' });
  assert.equal(parseMachine('#/m/remote/s/review/findings'), 'remote');
  assert.deepEqual(parseHash('#/s/review'), { kind: 'session', sessionId: 'review' });
});

test('findings notifications respect desktop preferences and open the findings drawer on the right machine', t => {
  const settings = new Map(); const notifications = [];
  const stubGlobal = (name, value) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name]; });
  };
  stubGlobal('localStorage', { getItem: key => settings.get(key) ?? null });
  stubGlobal('window', { location: { hash: '#/p/project' }, focus() {} });
  stubGlobal('document', { visibilityState: 'visible', title: '', querySelector: () => ({}) });
  class DesktopNotification {
    static permission = 'granted';
    constructor(title, options) { this.title = title; this.options = options; notifications.push(this); }
    close() {}
  }
  stubGlobal('Notification', DesktopNotification);
  const session = { id: 'review', title: 'Review de livraison', pendingFindings: 2, epic: { id: 'epic', title: 'Livraison' } };
  settings.set('cerebro.desktopNotif', '0'); showFindingsNotification(session); assert.equal(notifications.length, 0);
  settings.delete('cerebro.desktopNotif'); DesktopNotification.permission = 'denied'; showFindingsNotification(session); assert.equal(notifications.length, 0);
  DesktopNotification.permission = 'granted'; window.location.hash = '#/s/review'; showFindingsNotification(session); assert.equal(notifications.length, 0);
  window.location.hash = '#/p/project'; showFindingsNotification(session, 'remote'); assert.equal(notifications.length, 1);
  assert.match(notifications[0].title, /2 findings de review à traiter/);
  assert.match(notifications[0].options.body, /Livraison/);
  notifications[0].onclick(); assert.equal(window.location.hash, '#/m/remote/s/review/findings');
  updateAttentionIndicators(0, 1, 2); assert.match(document.title, /2 findings à traiter/);
  updateAttentionIndicators(0, 0, 0); assert.equal(document.title, 'Cerebro');
});
