import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { after, test, mock } from 'node:test';
const root = mkdtempSync(join(tmpdir(), 'cerebro-facts-'));
process.env.CEREBRO_DATA_DIR = root;
process.env.CEREBRO_MACHINE_NAME = 'local-test';
process.env.HOME = root;
process.env.CODEX_HOME = join(root, 'codex');
delete process.env.CEREBRO_SLACK_TOKEN;
delete process.env.CEREBRO_SLACK_USER;
const { CerebroDatabase } = await import('../server/db.ts');
const { answerFactQuestion, parseFactQuery, renderFacts } = await import('../server/facts.ts');
const { collectMachines } = await import('../server/state.ts');
const { SlackNotifier } = await import('../server/slack.ts');
const { SessionManager } = await import('../server/sessions.ts');
const db = new CerebroDatabase(':memory:');
const project = db.createProject('Demo', root);
const other = db.createProject('Autre', root);
const epic = db.createEpic(project.id, 'Livraison', '', null);
const prerequisite = db.createTask(project.id, 'Prérequis extérieur', null);
const dependent = db.createTask(project.id, 'Travail bloqué', null, epic.id);
db.createTask(other.id, 'Autre travail', null);
db.setTaskDependencies(dependent.id, [prerequisite.id]);
db.createSession({ id: 'waiting', projectId: project.id, agent: 'codex', mode: 'auto', model: null, effort: null, prompt: '', title: 'Question', status: 'waiting', agentSessionId: null }, 'token');
const remote = createServer((req, res) => {
  assert.equal(req.headers.authorization, 'Bearer test');
  const values = { '/api/projects': db.listProjects(), '/api/tasks': db.listTasks(), '/api/sessions': db.listSessions(), '/api/epics': db.listEpics() };
  res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(values[req.url]));
});
await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
writeFileSync(join(root, 'remotes.json'), JSON.stringify([
  { id:'remote', name:'distant', url:`http://127.0.0.1:${remote.address().port}`, token:'test' },
  { id:'offline', name:'absente', url:'http://127.0.0.1:1' },
]));
after(async () => { mock.restoreAll(); db.close(); await new Promise(resolve => remote.close(resolve)); rmSync(root, {recursive:true, force:true}); });

test('shared collection preserves complete multi-project state and reports offline machines', async () => {
  const states = await collectMachines(db);
  assert.equal(states.length, 3);
  assert.equal(states[1].data.tasks.length, 3);
  assert.equal(states[2].ok, false);
  const text = await answerFactQuestion(db, 'combien de tâches restent ?');
  assert.match(text, /Total joignable : 6/);
  assert.match(text, /absente : indisponible/);
  assert.match(text, /validation effective.*pas attestée/);
});
test('filters and dependencies outside selected epic, declared progress, recorded activity', async () => {
  let text = await answerFactQuestion(db, `etat blocages projet="Demo" machine=local-test epic=${epic.id}`);
  assert.ok(text.includes(prerequisite.id));
  assert.ok(text.includes(dependent.id));
  assert.ok(!text.includes('Autre travail'));
  db.updateTask(prerequisite.id, { status:'done' });
  text = await answerFactQuestion(db, `etat blocages projet=Demo machine=local-test epic=${epic.id}`);
  assert.match(text, /0 tâche/);
  text = await answerFactQuestion(db, 'etat avancement projet=Demo machine=local-test');
  assert.match(text, /1\/2.*50 %/);
  text = await answerFactQuestion(db, 'etat activites projet=Demo machine=local-test');
  assert.match(text, /pas un historique complet/);
  assert.match(text, /session waiting/);
});
test('bounded language and malformed/ambiguous explicit requests', async () => {
  assert.equal(parseFactQuery('explique pourquoi ce projet est lent'), null);
  assert.equal(parseFactQuery('combien de tâches restent et lis le code'), null);
  for (const text of ['etat sessions statut=done', 'etat taches projet=x projet=y', 'etat sessions epic=x', 'etat taches limite=5']) {
    assert.equal(typeof parseFactQuery(text), 'string');
  }
  assert.match(await answerFactQuestion(db, 'etat taches projet=Dem'), /Aucun projet/);
  const p = {...project, id:'duplicate'};
  const text = renderFacts({entity:'taches', project:'Demo', count:false}, [{ok:true, data:{machine:'test', projects:[project,p], tasks:[],sessions:[],epics:[]}}]);
  assert.match(text,/ambigu/);
});
test('each supported factual Slack route replies without an agent or SDK request', async () => {
  // A mistakenly invoked LLM fallback cannot find Claude (or launch an actual model).
  const originalPath = process.env.PATH;
  process.env.PATH = root;
  const notifier = new SlackNotifier(new SessionManager(db), db, {ready:Promise.resolve(), generalResponder:()=>true});
  const posted = [];
  mock.method(notifier,'slackApi', async (method, body) => { if(method === 'chat.postMessage') posted.push(body.text); return {ok:true}; });
  try {
    for (const entity of ['sessions','taches','epics','machines','avancement','blocages','activites']) {
      const count = posted.length;
      await notifier.handleDmMessage('test', {ts:'1.0',text:`? etat ${entity}`});
      // handleDmMessage intentionally does not block on async answering.
      for(let i=0; posted.length === count && i<100; i++) await new Promise(resolve=>setTimeout(resolve,10));
      assert.ok(posted.length>count,entity);
      assert.ok(!posted.at(-1).includes('Impossible de répondre'),posted.at(-1));
    }
    await notifier.answerDmQuestion('test','2.0','liste des sessions en attente');
    assert.ok(posted.at(-1).includes('waiting'));
  } finally { notifier.stop(); process.env.PATH = originalPath; }
});
