import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LedgerWorkerClient } from '../server/changes/ledgerWorkerClient.ts';
import { WriterRegistry } from '../server/changes/writers.ts';
import { setProjectDir } from '../server/project.ts';
import { ThreadStore } from '../server/threads/store.ts';

const home = process.argv[2]!;
const repo = join(home, 'repo');
const config = join(home, 'config');
mkdirSync(repo);
mkdirSync(config);
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, stdio: 'pipe' });
git('init', '-q', '--template=', '-b', 'main');
git('config', 'user.name', 'Vizzo');
git('config', 'user.email', 'vizzo@example.invalid');
const file = join(repo, 'button.txt');
writeFileSync(file, 'red\n');
git('add', 'button.txt');
git('commit', '-qm', 'Base');
const store = new ThreadStore();
store.persistTo(join(config, 'threads.json'));
setProjectDir(repo);
const thread = store.create({
  pageUrl: 'http://localhost/', selector: 'button', domPath: 'body > button', tag: 'button', label: null, text: null,
  role: null, dataSource: null, bounds: { x: 0, y: 0, width: 1, height: 1 },
}, 'the button', 'task');
store.addMessage(thread.threadId, { turnId: 'first', role: 'user', kind: 'request', text: 'Paint it green' });
store.flush();
const ledger = new LedgerWorkerClient(join(config, 'ledger.json'));
const registry = new WriterRegistry(ledger);
const execution = registry.queue({ writer: { kind: 'thread', id: thread.threadId }, title: 'the button', request: 'Paint it green', folder: repo, purpose: 'request', harness: 'codex' });
try {
  await execution.run(async () => {
    writeFileSync(file, 'green\n');
    execution.edits('button-session', 'edit', [{ path: file, from: 'red\n', to: 'green\n' }]);
  });
  await execution.settled;
  await registry.flush();
} finally { await ledger.close(); }
process.stdout.write(thread.threadId);
