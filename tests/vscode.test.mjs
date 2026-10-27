import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'cerebro-vscode-'));
process.env.CEREBRO_DATA_DIR = join(root, 'data');
process.env.CEREBRO_BIND_TOKEN = 'secret-bind-token';
const envFile = join(root, 'server-env.json');
const serverDataDir = join(root, 'data', 'vscode');
mkdirSync(serverDataDir, { recursive: true });

// Faux serveur VS Code : écoute sur le port demandé (0), l'annonce comme le vrai, ignore SIGTERM
// et consigne l'environnement reçu.
const fake = join(root, 'code-server');
writeFileSync(
  fake,
  `#!${process.execPath}
const { createServer } = require('node:http');
require('node:fs').writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));
process.on('SIGTERM', () => {});
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const server = createServer((_, res) => res.end('vscode'));
server.listen(port, '127.0.0.1', () => {
  console.log('Web UI available at http://localhost:' + server.address().port + '?tkn=x');
});
`,
);
chmodSync(fake, 0o755);
process.env.CEREBRO_VSCODE_SERVER = fake;

const { VscodeServer } = await import('../server/vscode.ts');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const children = [];
after(() => {
  for (const child of children) if (alive(child.pid)) child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

test(
  'VS Code : port choisi par le serveur, seuls nos processus sont arrêtés, SIGKILL en repli',
  { skip: process.platform !== 'linux' },
  async () => {
    // Programme de l'utilisateur qui nomme le dossier sans avoir été lancé par Cerebro.
    const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', serverDataDir], { stdio: 'ignore' });
    children.push(decoy);
    // Reste d'une exécution précédente de Cerebro.
    const leftover = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)', '--server-data-dir', serverDataDir],
      {
        stdio: 'ignore',
        env: { ...process.env, CEREBRO_VSCODE_DATA_DIR: serverDataDir },
      },
    );
    children.push(leftover);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const vscode = new VscodeServer();
    const running = await vscode.ensure();
    assert.ok(running.port > 0);
    assert.equal(await (await fetch(`http://127.0.0.1:${running.port}/`)).text(), 'vscode');
    assert.equal(alive(leftover.pid), false);
    assert.equal(alive(decoy.pid), true);

    await vscode.stop();
    await assert.rejects(fetch(`http://127.0.0.1:${running.port}/`));
    assert.equal(alive(decoy.pid), true);

    // Le terminal et les extensions de VS Code n'héritent d'aucun secret de Cerebro, seulement du marqueur.
    const env = JSON.parse(readFileSync(envFile, 'utf8'));
    assert.equal(env.CEREBRO_BIND_TOKEN, undefined);
    assert.equal(env.CEREBRO_VSCODE_DATA_DIR, serverDataDir);
  },
);
