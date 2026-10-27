import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(os.tmpdir(), 'cerebro-db-savepoint-'));
process.env.CEREBRO_DATA_DIR = join(root, 'data');
const { CerebroDatabase } = await import('../server/db.ts');
const db = new CerebroDatabase(join(root, 'cerebro.db'));
after(() => { db.connection.close(); rmSync(root, { recursive: true, force: true }); });

const names = () => db.listProjects().map((project) => project.name);

test('une transaction imbriquée en échec n’annule que son propre travail', () => {
  db.transaction(() => {
    db.createProject('externe', root);
    assert.throws(() => db.transaction(() => {
      db.createProject('interne', root);
      throw new Error('échec interne');
    }), /échec interne/);
    assert.equal(db.connection.isTransaction, true);
  }, 'IMMEDIATE');
  assert.deepEqual(names(), ['externe']);
  assert.equal(db.connection.isTransaction, false);
});

test('l’échec externe annule aussi les SAVEPOINT déjà validés', () => {
  assert.throws(() => db.transaction(() => {
    db.transaction(() => db.createProject('validé', root));
    throw new Error('échec externe');
  }), /échec externe/);
  assert.deepEqual(names(), ['externe']);
  assert.equal(db.connection.isTransaction, false);
});
