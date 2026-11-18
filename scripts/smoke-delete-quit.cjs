// Run: npm run build:electron && npx electron scripts/smoke-delete-quit.cjs
// A real voice utility flushes its journal, quits with a blocked background commit and recovers it on restart.
const { app, utilityProcess } = require('electron');
const { WebSocket } = require('ws');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const root = join(__dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'vizzo-delete-quit-'));
app.setPath('userData', home);
const config = join(home, 'config');
const threads = join(config, 'threads.json');
const journal = join(config, 'ledger.json');
const repo = join(home, 'repo');
const index = join(repo, '.git', 'index');
const foreign = `${index}.lock`;
let active;
const sockets = [];
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const diskJob = () => Object.values(JSON.parse(readFileSync(journal)).projects).flatMap(p => Object.values(p.commitJobs ?? {}))[0];
const durableThreads = () => JSON.parse(readFileSync(threads)).threads;
const pause = () => new Promise(resolve => setTimeout(resolve, 15));
async function wait(test, label) {
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) { const result = test(); if (result) return result; await pause(); }
  throw new Error(`Timeout ${label}`);
}
async function boot() {
  const child = active = utilityProcess.fork(join(root, 'dist-electron/server.mjs'), [], { env: {
    ...process.env, VIZZO_THREADS_FILE: threads, PROJECT_DIR: repo, PORT: '0', WARM_AGENTS: '0', LOCAL_TTS: '0', LOCAL_STT: '0', FAKE_VENDORS: '1',
    LLM_SELECTION_FILE: join(config, 'llm-selection.json'), SPEECH_SELECTION_FILE: join(config, 'speech-selection.json'), APP_ROOT: `${root}/`,
  }, stdio: 'inherit' });
  const messages = [];
  child.on('message', msg => messages.push(msg));
  const { port } = await wait(() => messages.find(m => m.type === 'ready'), 'server ready');
  const origin = `http://127.0.0.1:${port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
  sockets.push(ws);
  const received = [];
  ws.on('message', (msg, binary) => { if (!binary) received.push(JSON.parse(msg.toString())); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { child, messages, received, send: msg => ws.send(JSON.stringify(msg)) };
}
async function quit(server) {
  const exited = new Promise(resolve => server.child.once('exit', resolve));
  assert(server.child.kill(), 'the disposable voice process must still be running');
  await exited;
  active = undefined;
}
async function main() {
  await app.whenReady();
  const threadId = execFileSync(join(root, 'node_modules/.bin/tsx'), [join(__dirname, 'smoke-delete-quit-seed.ts'), home], { encoding: 'utf8' }).trim();
  const base = git('rev-parse', 'HEAD');
  const oldIndex = readFileSync(index);
  const first = await boot();
  const existing = await wait(() => first.received.find(m => m.type === 'threads.snapshot'), 'first thread snapshot');
  assert.equal(existing.threads[0].threadId, threadId);
  // Another Git process owns this lock. The delete job stays active in acquire-index long enough to quit.
  const sentinel = 'temporary foreign lock';
  writeFileSync(foreign, sentinel, { flag: 'wx' });
  const lockIdentity = statSync(foreign).ino;
  first.send({ type: 'thread.delete', requestId: 'delete', threadId, mode: 'commit' });
  await wait(() => first.received.find(m => m.type === 'thread.delete.done' && m.requestId === 'delete'), 'durable deletion');
  await wait(() => first.messages.find(m => m.type === 'activity' && m.running.some(title => /commit/i.test(title))), 'background commit activity');
  first.child.postMessage({ type: 'flush' });
  await wait(() => first.messages.find(m => m.type === 'flushed'), 'flush during commit');
  await wait(() => diskJob()?.journal.step === 'acquire-index', 'journaled attempt to acquire the index');
  assert.equal(diskJob().journal.phase, 'locking');
  assert.deepEqual(durableThreads(), []);
  assert(!first.messages.some(m => /commit/i.test(m.finished?.title ?? '')));
  await quit(first);

  const recovered = await boot();
  const snapshot = await wait(() => recovered.received.find(m => m.type === 'threads.snapshot'), 'recovered thread snapshot');
  assert.deepEqual(snapshot.threads, []);
  const job = diskJob();
  assert.equal(job.outcome.status, 'blocked');
  assert.equal(job.outcome.evidence, 'not-attempted');
  assert.equal(readFileSync(foreign, 'utf8'), sentinel);
  assert.equal(statSync(foreign).ino, lockIdentity);
  assert.equal(git('rev-parse', 'HEAD'), base);
  assert.deepEqual(readFileSync(index), oldIndex);
  assert.equal(readFileSync(join(repo, 'button.txt'), 'utf8'), 'green\n');
  const groups = Object.values(JSON.parse(readFileSync(journal)).projects).flatMap(p => Object.values(p.closedThreads ?? {}));
  assert.deepEqual(groups.map(({threadId, removalPending}) => ({ threadId, removalPending })), [{ threadId, removalPending: false }]);
  await quit(recovered);

  rmSync(foreign);
  const afterLock = await boot();
  assert.equal(diskJob().outcome.status, 'refused');
  assert.equal(diskJob().outcome.evidence, 'not-attempted');
  assert.equal(git('rev-parse', 'HEAD'), base);
  assert.deepEqual(readFileSync(index), oldIndex);
  await quit(afterLock);
  console.log('Real Electron quit/recovery passed: quit during a background thread commit, kept the closed group and foreign lock, and proved the commit was never attempted.');
}
main().then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) {
  for (const ws of sockets) ws.terminate();
  if (active) active.kill();
  rmSync(home, { recursive: true, force: true });
  app.exit(code);
}
