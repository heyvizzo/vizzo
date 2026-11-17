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
const evaluate = source => chat.webContents.executeJavaScript(source);
const confirmText = () => evaluate('document.querySelector(".reset-confirm")?.innerText ?? null');
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
  await until(() => peer && evaluate('document.querySelectorAll(".thread-item").length===3'), 'threads listed');

  // With threads: ask first, and say how many go and how many get stopped.
  await addNote();
  await clickReset();
  await until(confirmText, 'confirmation shows');
  const text = await confirmText();
  assert.match(text, /Clear conversation\?/);
  assert.match(text, /3 threads will be deleted/);
  assert.match(text, /1 thread is still working and will be stopped/);
  assert.equal(resets(), 0, 'nothing reset before confirming');
  const artifacts = path.join(root, 'results', 'reset-confirm-smoke');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(path.join(artifacts, 'confirm.png'), (await chat.webContents.capturePage(undefined, { stayHidden: true })).toPNG());

  // Cancel keeps everything.
  await evaluate('document.querySelector(".reset-confirm-actions button:not(.danger)").click()');
  assert.equal(await confirmText(), null, 'Cancel closes it');
  assert.equal(resets(), 0);
  assert.equal(await evaluate('document.querySelectorAll(".thread-item").length'), 3, 'threads kept');

  // Esc closes it too.
  await clickReset();
  await until(confirmText, 'confirmation shows again');
  await evaluate('document.querySelector(".reset-confirm").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  assert.equal(await confirmText(), null, 'Esc closes it');
  assert.equal(resets(), 0);

  // Idle threads only: says nothing will be stopped.
  threads[1].state = 'idle'; send({ type: 'thread', thread: threads[1] });
  await until(() => evaluate('!document.querySelector(".thread-item[data-state=running]")'), 'no thread running');
  await clickReset();
  await until(confirmText, 'confirmation shows for idle threads');
  assert.match(await confirmText(), /None of them are working, so nothing will be stopped/);

  // Confirm clears.
  await evaluate('document.querySelector(".reset-confirm-actions .danger").click()');
  await until(() => resets() === 1, 'reset sent');
  assert.equal(await confirmText(), null);
  assert.equal(await evaluate('document.querySelectorAll(".thread-item").length'), 0, 'threads cleared');

  // Nothing to lose: no question.
  await addNote();
  await clickReset();
  await until(() => resets() === 2, 'reset sent without asking');
  assert.equal(await confirmText(), null);
  assert.deepEqual(errors, []);
  console.log('Reset confirm smoke passed: asks with thread and working counts, Cancel/Esc keep everything, confirm clears, no question when nothing is lost.');
}

main().then(() => finish(0), error => { console.error(error); return finish(1); });
async function finish(code) {
  chat?.destroy();
  for (const client of sockets?.clients ?? []) client.terminate();
  sockets?.close(); await vite?.close();
  rmSync(userData, { recursive: true, force: true });
  app.exit(code);
}
