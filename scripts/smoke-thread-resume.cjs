// A thread restored after the app was closed mid-run (server/threads/persist.ts): its marker and sidebar row say
// "interrupted", and its panel's Resume sends a follow-up to that thread. Real sandboxed panels, a fake server.
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
let chat, page, vite, sockets, peer, pageReady = false;
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
ipcMain.on('chat-settings:get', e => { e.returnValue = JSON.stringify({ instant: true, alwaysListen: false }); });
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
ipcMain.on('page:ready', () => { pageReady = true; });
const send = msg => peer.send(JSON.stringify(msg));
const starts = () => received.filter(m => m.type === 'turn.start');
const stops = () => received.filter(m => m.type === 'task.stop');
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
const stopVisible = async () => !!(await node('.th-panel .th-stop'));
const draft = text => inspect('.th-panel textarea', 'function(text){this.value=text;this.dispatchEvent(new Event("input",{bubbles:true}));this.focus();this.setSelectionRange(2,5)}', [text]);
const fieldState = () => inspect('.th-panel textarea', 'function(){return {value:this.value,start:this.selectionStart,end:this.selectionEnd,focused:this.getRootNode().activeElement===this}}');
function done(start) {
  send({ type: 'turn.done', turnId: start.turnId, run: {
    runId: start.turnId, turnId: start.turnId, approach: start.config.approach, config: start.config,
    marks: {}, metrics: {}, transcript: start.text, pointing: [], voiceText: '', solverText: '', usage: {}, costUsd: 0, clock: { rttMs: 0, offsetMs: 0 },
  } });
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
  await until(() => starts().length === 1, 'Resume sends a follow-up');
  assert.equal(starts()[0].threadId, thread.threadId, 'to the interrupted thread');
  assert.match(starts()[0].text, /Continue where you left off/);
  // Its run starts: the flag goes, and the button with it.
  send({ type: 'decision', turnId: starts()[0].turnId, intent: 'task', estimateS: null, background: true, threadId: thread.threadId });
  delete thread.interrupted; thread.state = 'running'; send({ type: 'thread', thread }); done(starts()[0]);
  await until(async () => !(await node('.th-panel .kind-interrupted .th-held')), 'Resume goes once the thread runs');
  assert.equal(await evaluate('document.querySelector(".thread-item").dataset.state'), 'running');
  assert.deepEqual(errors, []);
  console.log('Thread Resume smoke passed: interrupted shows in the sidebar and the panel, Resume sends a follow-up to its thread.');
}

main().then(() => finish(0), error => { console.error(error); return finish(1); });
async function finish(code) {
  chat?.destroy(); page?.destroy();
  for (const client of sockets?.clients ?? []) client.terminate();
  sockets?.close(); await vite?.close();
  rmSync(userData, { recursive: true, force: true });
  app.exit(code);
}
