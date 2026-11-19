// A thread restored after the app was closed mid-run (server/threads/persist.ts): its marker and sidebar row say
// "interrupted", and Resume and Continue use the native follow-up path. Also exercises the panel's delete matrix.
// Run: npm run smoke:thread-resume
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const root = path.resolve(__dirname, '..');
const userData = mkdtempSync(path.join(tmpdir(), 'vizzo-thread-resume-'));
app.setPath('userData', userData);
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
let chat, page, vite, sockets, peer, queueState, pageReady = false;
const errors = [], received = [];
const thread = {
  threadId: 'thread-stop', pageUrl: 'data:text/html', title: 'the button', state: 'idle', intent: 'task',
  summary: '', unread: false, awaitingReply: false, createdAt: 0, lastInteractionAt: 0,
  anchor: { pageUrl: 'data:text/html', selector: '#target', domPath: 'body > #target', dataSource: null, label: 'Target', text: 'Target', role: null, tag: 'button', bounds: { x: 400, y: 200, width: 100, height: 40 } },
  interrupted: true,
  messages: [
    { id: 'm1', turnId: 't1', at: 0, role: 'user', kind: 'request', text: 'Make it bigger.' },
    { id: 'm2', turnId: null, at: 1, role: 'system', kind: 'interrupted', text: 'Vizzo was closed before this finished.' },
  ],
};
ipcMain.on('hotkeys:get', e => { e.returnValue = null; });
ipcMain.on('chat-settings:get', e => { e.returnValue = JSON.stringify({ instant: true, alwaysListen: false, gitSourceControl: true }); });
ipcMain.handle('attention:get', () => null);
ipcMain.handle('project:get', () => null);
ipcMain.handle('page:url', () => thread.pageUrl);
ipcMain.handle('page:state', () => ({ tFrom: null }));
ipcMain.handle('page:history-state', () => ({ back: false, forward: false }));
ipcMain.handle('drawing:get', () => false);
ipcMain.handle('comment:get', () => false);
ipcMain.on('page:cmd', (_e, cmd) => page.webContents.send('page:cmd', cmd));
ipcMain.on('page:thread', (_e, action) => chat?.webContents.send('page:thread', action));
ipcMain.on('page:comment', (_e, action) => chat?.webContents.send('page:comment', action));
ipcMain.on('page:ready', e => { pageReady = true; e.sender.send('changes:page-status', null, true); });
ipcMain.on('queue:state', (_e, state) => { queueState = state; });
const send = msg => peer.send(JSON.stringify(msg));
const starts = () => received.filter(m => m.type === 'turn.start');
const continuations = () => received.filter(m => m.type === 'thread.continue');
const previews = () => received.filter(m => m.type === 'thread.delete.preview');
const deletes = () => received.filter(m => m.type === 'thread.delete');
const reply = (request, state, reason) => send({ type: 'thread.delete.preview', requestId: request.requestId, threads: [
  { threadId: request.threadIds[0], state, defaultMode: state === 'complete' ? 'commit' : 'keep', reason },
] });
const evaluate = source => chat.webContents.executeJavaScript(source);
async function until(fn, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    assert.deepEqual(errors, [], 'renderers must not throw');
    try { if (await fn()) return; }
    catch (e) {
      if (!/Could not find node with given id|No node with given id found/.test(String(e))) throw e;
    }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timeout: ${label}`);
}
const cdp = (method, params = {}) => page.webContents.debugger.sendCommand(method, params);
async function node(selector) {
  const { root: doc } = await cdp('DOM.getDocument', { depth: -1, pierce: true });
  const shadows = [];
  const walk = n => { shadows.push(...(n.shadowRoots ?? [])); for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c); };
  walk(doc);
  for (const shadow of shadows) {
    const { nodeId } = await cdp('DOM.querySelector', { nodeId: shadow.nodeId, selector });
    if (nodeId) return nodeId;
  }
  return null;
}
async function inspect(selector, functionDeclaration, args = []) {
  const nodeId = await node(selector);
  assert(nodeId, `Missing ${selector}`);
  const { object } = await cdp('DOM.resolveNode', { nodeId });
  const result = await cdp('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue: true });
  assert(!result.exceptionDetails, result.exceptionDetails?.text);
  return result.result.value;
}
async function click(selector) {
  const { x, y } = await inspect(selector, 'function(){const r=this.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}');
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
const choices = () => inspect('.th-delete-actions', 'function(){return [...this.children].map(b => b.textContent)}');
const focused = () => inspect('.th-panel', 'function(){const active=this.getRootNode().activeElement;return active?.textContent || active?.getAttribute("aria-label")}');
async function key(key, shift = false) {
  const code = { Escape: 27, Enter: 13, Tab: 9 }[key];
  const event = { key, code: key, windowsVirtualKeyCode: code, modifiers: shift ? 8 : 0 };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}
async function preview(state, reason) {
  const count = previews().length;
  await click('.th-panel .th-trash');
  await until(() => previews().length === count + 1, `preview requested for ${state}`);
  assert.deepEqual(previews().at(-1).threadIds, [thread.threadId]);
  reply(previews().at(-1), state, reason);
  await until(() => node('.th-delete-actions .th-danger'), `${state} choices are ready`);
}

async function main() {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const { createServer } = await import('vite');
  vite = await createServer({ configFile: false, root: path.join(root, 'web'), server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{
    name: 'thread-resume-fixtures',
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
    send({ type: 'threads.snapshot', threads: [thread] });
    ws.on('message', (data, binary) => {
      if (binary) return;
      const msg = JSON.parse(data.toString()); received.push(msg);
      if (msg.type === 'ping') send({ type: 'pong', id: msg.id, clientNow: msg.clientNow, serverNow: performance.now() });
    });
  });
  await vite.listen();
  for (const kind of ['page', 'chat']) {
    const win = new BrowserWindow({ show: false, width: kind === 'page' ? 1000 : 480, height: 760, webPreferences: {
      preload: path.join(root, 'dist-electron', kind === 'page' ? 'page-preload.cjs' : 'preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false,
    } });
    if (kind === 'page') page = win; else chat = win;
    let loadTimer;
    await Promise.race([
      win.loadURL(kind === 'page' ? `data:text/html,${encodeURIComponent('<style>body{font:16px system-ui}button{position:absolute;left:400px;top:200px}#other{top:400px}</style><button id="target">Target</button>')}` : `http://127.0.0.1:${vite.httpServer.address().port}/chat.html`),
      new Promise((_, reject) => { loadTimer = setTimeout(() => reject(new Error(`Timeout loading ${kind} (page ready: ${pageReady})`)), 10000); }),
    ]).finally(() => clearTimeout(loadTimer));
    win.webContents.debugger.attach('1.3');
    win.webContents.debugger.on('message', (_e, method, params) => { if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text); });
    await win.webContents.debugger.sendCommand('Runtime.enable');
  }
  await until(() => peer && pageReady && evaluate('document.querySelectorAll(".thread-item").length===1'), 'chat and page ready');
  page.webContents.send('page:open-thread', thread.threadId);
  await until(() => node('.th-panel'), 'thread opens');
  assert.equal(await evaluate('document.querySelector(".thread-item .thread-state").textContent'), 'interrupted', 'the sidebar row says interrupted');
  assert.equal(await inspect('.th-panel .th-state', 'function(){return this.textContent}'), 'interrupted', 'the panel chip says interrupted');
  assert.equal(await inspect('.th-panel .kind-interrupted .th-held button', 'function(){return this.textContent}'), 'Resume');
  await click('.th-panel .kind-interrupted .th-held button');
  await until(() => continuations().length === 1, 'Resume sends a continuation');
  assert.equal(continuations()[0].threadId, thread.threadId, 'to the interrupted thread');
  assert.equal(continuations()[0].config.silent, true);
  await until(() => inspect('.th-continue', 'function(){return this.disabled}'), 'Resume disables while dispatching');
  // Its run starts: the flag goes, and the button with it.
  delete thread.interrupted; thread.state = 'running'; send({ type: 'thread', thread });
  await until(async () => !(await node('.th-panel .kind-interrupted .th-held')), 'Resume goes once the thread runs');
  assert.equal(await evaluate('document.querySelector(".thread-item").dataset.state'), 'running');

  // The last task stopped or failed with surviving work. A retry refusal restores the action.
  Object.assign(thread, { state: 'failed', incomplete: true, incompleteReason: 'The last task failed.', canContinue: true });
  send({ type: 'thread', thread });
  await until(() => node('.th-continue'), 'Continue is available');
  assert.equal(await inspect('.th-continue', 'function(){return this.textContent}'), 'Continue');
  await click('.th-continue');
  await until(() => continuations().length === 2, 'Continue uses the same action');
  assert.equal(continuations()[1].threadId, continuations()[0].threadId);
  send({ type: 'error', source: 'session', message: 'Session is busy.', requestId: continuations()[1].requestId });
  await until(async () => !(await inspect('.th-continue', 'function(){return this.disabled}')), 'retry available after refusal');
  assert.equal(starts().length, 0, 'continuation does not send ordinary typed turns');

  // All server rows show and focus their default, Escape returns to Delete, and Tab reaches the other actions.
  const matrix = [
    ['none', undefined, ['Delete', 'Cancel']],
    ['complete', 'Also has other changes.', ['Commit and delete', 'Delete, keep uncommitted', 'Cancel']],
    ['incomplete', 'The last task failed.', ['Delete, keep uncommitted', 'Cancel']],
    ['working', undefined, ['Stop and delete', 'Cancel']],
  ];
  for (const [state, reason, expected] of matrix) {
    await preview(state, reason);
    assert.deepEqual(await choices(), expected);
    assert.equal(await focused(), expected[0]);
    if (reason) assert.equal(await inspect('.th-confirm', 'function(){return this.textContent}'), reason);
    if (state === 'working') assert.match(await inspect('.th-confirm', 'function(){return this.textContent}'), /stopped part-way/);
    await key('Tab', true);
    assert.equal(await focused(), 'Cancel');
    await key('Escape');
    assert.equal(await node('.th-foot'), null);
    assert.equal(await focused(), 'Delete');
  }
  assert.equal(deletes().length, 0, 'cancelled dialogs leave the thread alone');

  // A late response for an abandoned preview cannot replace the current dialog.
  await click('.th-trash');
  await until(() => previews().length === 5, 'preview awaiting reply');
  await key('Escape');
  await click('.th-trash');
  await until(() => previews().length === 6, 'new preview awaiting reply');
  reply(previews()[4], 'working');
  reply(previews()[5], 'complete');
  await until(() => node('.th-delete-actions .th-danger'), 'new preview ready');
  assert.deepEqual(await choices(), matrix[1][2]);
  assert.equal(await focused(), 'Commit and delete');
  await key('Enter');
  await until(() => deletes().length === 1, 'Enter confirms the default');
  assert.equal(deletes()[0].mode, 'commit');
  assert.equal(deletes()[0].threadId, thread.threadId);
  await until(() => node('.th-trash:disabled'), 'pending deletion disables the trash');
  assert(await node('.th-panel'), 'panel survives until durable handoff');
  assert(await node('.th-marker'), 'marker survives until durable handoff');
  send({ type: 'thread.removed', threadId: thread.threadId });
  await until(async () => !(await node('.th-marker')) && !(await node('.th-panel')), 'removal closes the panel and marker');

  // Queued feedback on this element uses the old local confirmation and sends nothing to the server.
  chat.webContents.send('queue:cmd', { type: 'instant', on: false });
  await until(() => queueState && !queueState.instant, 'Instant disabled');
  const sample = { t: Date.now(), x: 410, y: 210, scrollX: 0, scrollY: 0, elementPath: thread.anchor.domPath, dataSource: null, label: 'Target' };
  for (const text of ['First queued request', 'Second queued request']) chat.webContents.send('page:comment', { type: 'comment.send', text, sample });
  await until(() => queueState.count === 2, 'both requests queued');
  await until(() => node('.th-marker[data-state=queued]'), 'queued marker shown');
  await click('.th-marker[data-state=queued]');
  await until(() => node('.th-trash'), 'queued panel opens');
  await click('.th-trash');
  assert.deepEqual(await choices(), ['Delete', 'Cancel']);
  assert.equal(await focused(), 'Delete');
  await key('Enter');
  await until(() => queueState.count === 0, 'local delete removes feedback grouped at the element');
  assert.equal(previews().length, 6, 'queued delete never requests a server preview');
  assert.equal(deletes().length, 1, 'queued delete never sends a server mutation');
  assert.equal(starts().length, 0);
  assert.deepEqual(errors, []);
  console.log('Thread Resume smoke passed: Resume and Continue use the native action, delete confirms by keyboard, stale previews are ignored, and removal waits for handoff.');
}

main().then(() => finish(0), error => { console.error(error); return finish(1); });
async function finish(code) {
  chat?.destroy(); page?.destroy();
  for (const client of sockets?.clients ?? []) client.terminate();
  sockets?.close(); await vite?.close();
  rmSync(userData, { recursive: true, force: true });
  app.exit(code);
}
