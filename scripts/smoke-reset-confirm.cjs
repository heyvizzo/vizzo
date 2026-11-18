// The chat's "New conversation" button asks before it deletes threads or stops work, and says how much.
// Run: npm run smoke:reset-confirm
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const root = path.resolve(__dirname, '..');
const userData = mkdtempSync(path.join(tmpdir(), 'vizzo-reset-confirm-'));
app.setPath('userData', userData);
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
let chat, vite, sockets, peer;
const errors = [], received = [];
const base = {
  pageUrl: 'data:text/html', intent: 'task', summary: '', unread: false, awaitingReply: false, createdAt: 0, lastInteractionAt: 0, messages: [],
  anchor: { pageUrl: 'data:text/html', selector: '#a', domPath: 'body > #a', dataSource: null, label: 'A', text: 'A', role: null, tag: 'button', bounds: { x: 0, y: 0, width: 10, height: 10 } },
};
const threads = [
  { ...base, threadId: 't1', title: 'one', state: 'idle' },
  { ...base, threadId: 't2', title: 'two', state: 'running' },
  { ...base, threadId: 't3', title: 'three', state: 'idle' },
  { ...base, threadId: 't4', title: 'four', state: 'idle' },
];
ipcMain.on('hotkeys:get', e => { e.returnValue = null; });
ipcMain.on('chat-settings:get', e => { e.returnValue = JSON.stringify({ instant: true, alwaysListen: false }); });
ipcMain.handle('attention:get', () => null);
ipcMain.handle('project:get', () => null);
ipcMain.handle('page:url', () => base.pageUrl);
ipcMain.handle('page:state', () => ({ tFrom: null }));
ipcMain.handle('drawing:get', () => false);
ipcMain.handle('comment:get', () => false);
ipcMain.on('page:cmd', () => {});
const send = msg => peer.send(JSON.stringify(msg));
const resets = () => received.filter(m => m.type === 'conversation.reset').length;
const previews = () => received.filter(m => m.type === 'thread.delete.preview');
const mutations = () => received.filter(m => ['thread.delete', 'threads.delete', 'conversation.reset', 'task.stop', 'turn.cancel'].includes(m.type));
const reply = (request, states) => send({ type: 'thread.delete.preview', requestId: request.requestId,
  threads: request.threadIds.map(threadId => ({ threadId, ...states[threadId] })) });
const states = {
  t1: { state: 'complete', defaultMode: 'commit', willCommit: true },
  t2: { state: 'working', defaultMode: 'keep' },
  t3: { state: 'complete', defaultMode: 'commit', willCommit: false },
  t4: { state: 'none', defaultMode: 'keep' },
};
const choices = ['commit', 'keep', 'keep', 'keep'].map((mode, i) => ({ threadId: threads[i].threadId, mode }));
const evaluate = source => chat.webContents.executeJavaScript(source);
const confirmText = () => evaluate('document.querySelector(".reset-confirm")?.innerText ?? null');
const confirmReady = () => evaluate('!!document.querySelector(".reset-confirm .danger")');
const listed = () => evaluate('document.querySelectorAll(".thread-item").length');
// The reset button only shows once the conversation has something in it.
const addNote = () => evaluate('(() => { const p = document.createElement("p"); p.className = "status note"; p.textContent = "earlier"; document.getElementById("messages").append(p); })()');
const clickReset = () => evaluate('document.getElementById("reset").click()');
async function until(fn, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    assert.deepEqual(errors, [], 'renderer must not throw');
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timeout: ${label}`);
}

async function main() {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const { createServer } = await import('vite');
  vite = await createServer({ configFile: false, root: path.join(root, 'web'), server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{
    name: 'reset-confirm-fixtures',
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (!req.url.startsWith('/api/')) return next();
      req.resume(); res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/llm/notice' ? null : req.url === '/api/speech/engines' ? { engines: [] } : req.url === '/api/llm/providers' ? [] : {}));
    }); },
  }] });
  sockets = new WebSocketServer({ noServer: true });
  vite.httpServer.on('upgrade', (req, socket, head) => { if (req.url === '/ws') sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws)); });
  sockets.on('connection', ws => {
    peer = ws;
    send({ type: 'threads.snapshot', threads });
    ws.on('message', (data, binary) => {
      if (binary) return;
      const msg = JSON.parse(data.toString()); received.push(msg);
      if (msg.type === 'ping') send({ type: 'pong', id: msg.id, clientNow: msg.clientNow, serverNow: performance.now() });
    });
  });
  await vite.listen();
  chat = new BrowserWindow({ show: false, width: 480, height: 760, webPreferences: {
    preload: path.join(root, 'dist-electron', 'preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false,
  } });
  await chat.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/chat.html`);
  chat.webContents.debugger.attach('1.3');
  chat.webContents.debugger.on('message', (_e, method, params) => { if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text); });
  await chat.webContents.debugger.sendCommand('Runtime.enable');
  await until(async () => peer && await listed() === 4, 'threads listed');

  // Cancel a pending preview. A late reply must not populate the next dialog.
  await addNote();
  await clickReset();
  await until(() => previews().length === 1, 'first preview requested');
  assert.match(await confirmText(), /Checking thread changes/);
  await evaluate('document.querySelector(".reset-confirm-actions button").click()');
  assert.equal(await confirmText(), null, 'Cancel closes it');
  assert.equal(await evaluate('document.activeElement.id'), 'reset', 'Cancel restores focus');
  await clickReset();
  await until(() => previews().length === 2, 'second preview requested');
  reply(previews()[0], { ...states, t1: { state: 'working', defaultMode: 'keep' } });
  reply(previews()[1], states);
  await until(confirmReady, 'current preview confirmed');
  const text = await confirmText();
  assert.match(text, /Clear conversation\?/);
  assert.match(text, /4 threads will be deleted/);
  assert.match(text, /1 thread will be committed, 2 kept uncommitted/);
  assert.match(text, /1 thread is still working and will be stopped/);
  assert.deepEqual(mutations(), [], 'preflight sends no mutation');
  const artifacts = path.join(root, 'results', 'reset-confirm-smoke');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(path.join(artifacts, 'confirm.png'), (await chat.webContents.capturePage(undefined, { stayHidden: true })).toPNG());

  await evaluate('document.querySelector(".reset-confirm").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  assert.equal(await confirmText(), null, 'Esc closes it');
  assert.equal(await evaluate('document.activeElement.id'), 'reset', 'Esc restores focus');
  assert.equal(resets(), 0);
  assert.equal(await listed(), 4, 'threads kept');

  // Clear previews the whole batch once. A working thread that goes idle still submits keep.
  await evaluate('document.getElementById("threads-clear").click()');
  await until(() => previews().length === 3, 'Clear previews all threads');
  assert.deepEqual(previews()[2].threadIds, threads.map(t => t.threadId));
  reply(previews()[2], states);
  await until(confirmReady, 'Clear shows preview');
  assert.match(await confirmText(), /1 thread will be committed, 2 kept uncommitted/);
  send({ type: 'thread', thread: { ...threads[1], state: 'idle' } });
  await until(() => evaluate('!document.querySelector(".thread-item[data-state=running]")'), 'thread became idle');
  await evaluate('document.querySelector(".reset-confirm-actions .danger").click()');
  await until(() => mutations().length === 1, 'one Clear mutation sent');
  assert.equal(mutations()[0].type, 'threads.delete');
  assert.deepEqual(mutations()[0].threads, choices);
  assert.equal(await listed(), 4, 'Clear waits for durable removal');
  for (const t of threads) send({ type: 'thread.removed', threadId: t.threadId });
  await until(async () => await listed() === 0, 'Clear removes confirmed threads');

  // The sidebar × uses the server's automatic choice and also waits for the acknowledgment.
  send({ type: 'threads.snapshot', threads });
  await until(async () => await listed() === 4, 'threads restored for single delete');
  await evaluate('document.querySelector(".thread-del").click()');
  await until(() => previews().length === 4, 'automatic mode requested');
  assert.deepEqual(previews()[3].threadIds, ['t1']);
  reply(previews()[3], states);
  await until(() => mutations().length === 2, 'single delete sent');
  assert.equal(mutations()[1].mode, 'commit');
  assert.equal(await listed(), 4, 'single delete waits for durable removal');
  send({ type: 'thread.removed', threadId: 't1' });
  await until(async () => await listed() === 3, 'single deletion confirmed');

  // Reset during a sent turn. It sends one mutation, with no earlier turn.cancel or task.stop.
  send({ type: 'threads.snapshot', threads });
  send({ type: 'job', job: { jobId: 'working-job', state: 'running', question: 'Background', startedAt: 0 } });
  await until(async () => await listed() === 4, 'threads restored for reset');
  await evaluate(`(() => {
    const form = document.querySelector('#compose textarea');
    form.value = 'An active request';
    form.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#compose .if-send').click();
  })()`);
  await until(() => received.some(m => m.type === 'turn.release'), 'turn in flight');
  await clickReset();
  await until(() => previews().length === 5, 'reset preflights before cancellation');
  reply(previews()[4], states);
  await until(confirmReady, 'reset shows commit, keep and work warning');
  assert.match(await confirmText(), /1 background task is running and will be stopped/);
  await evaluate('document.querySelector(".reset-confirm-actions .danger").click()');
  await until(() => resets() === 1, 'reset sent');
  assert.deepEqual(mutations().map(m => m.type), ['threads.delete', 'thread.delete', 'conversation.reset']);
  assert.deepEqual(mutations()[2].threads, choices);
  assert.equal(await confirmText(), null);
  assert.equal(await listed(), 4, 'reset keeps threads during durable handoff');
  assert.equal(await evaluate('!!document.querySelector(".turn")'), true, 'conversation remains until reset completes');
  send({ type: 'threads.snapshot', threads: [] });
  send({ type: 'conversation.reset.done', requestId: mutations()[2].requestId });
  await until(async () => await listed() === 0 && await evaluate('!document.querySelector(".turn")'), 'reset acknowledgment clears conversation');

  // Nothing to lose: no question.
  await addNote();
  await clickReset();
  await until(() => resets() === 2, 'reset sent without asking');
  assert.equal(await confirmText(), null);
  assert.deepEqual(errors, []);
  console.log('Reset confirm smoke passed: batches preview once, count tied and working threads, cap keep, keep markers through handoff, and reset without a preceding cancellation.');
}

main().then(() => finish(0), error => { console.error(error); return finish(1); });
async function finish(code) {
  chat?.destroy();
  for (const client of sockets?.clients ?? []) client.terminate();
  sockets?.close(); await vite?.close();
  rmSync(userData, { recursive: true, force: true });
  app.exit(code);
}
