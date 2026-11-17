// Real sandboxed thread panels and chat IPC, with controlled responses and microphone permission denied.
// Run: npm run smoke:thread-stop
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const root = path.resolve(__dirname, '..');
const userData = mkdtempSync(path.join(tmpdir(), 'vizzo-thread-stop-'));
app.setPath('userData', userData);
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
let chat, page, vite, sockets, peer, pageReady = false;
const errors = [], received = [];
const thread = {
  threadId: 'thread-stop', pageUrl: 'data:text/html', title: 'the button', state: 'idle', intent: 'task',
  summary: '', unread: false, awaitingReply: false, createdAt: 0, lastInteractionAt: 0,
  anchor: { pageUrl: 'data:text/html', selector: '#target', domPath: 'body > #target', dataSource: null, label: 'Target', text: 'Target', role: null, tag: 'button', bounds: { x: 400, y: 200, width: 100, height: 40 } },
  messages: [{ id: 'm1', turnId: null, at: 0, role: 'assistant', kind: 'result', text: 'Earlier answer.' }],
};
const other = { ...thread, threadId: 'other-thread', state: 'running', title: 'another task', anchor: { ...thread.anchor, selector: '#other', domPath: 'body > #other', text: 'Other' } };
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
    name: 'thread-stop-fixtures',
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
    send({ type: 'threads.snapshot', threads: [thread, other] });
    ws.on('message', (data, binary) => {
      if (binary) return;
      const msg = JSON.parse(data.toString()); received.push(msg);
      if (msg.type === 'ping') send({ type: 'pong', id: msg.id, clientNow: msg.clientNow, serverNow: performance.now() });
      if (msg.type === 'task.stop') {
        assert.deepEqual(msg.task, { kind: 'thread', threadId: thread.threadId }, 'stop targets only the open thread');
        thread.state = 'idle';
        send({ type: 'thread', thread });
      }
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
      win.loadURL(kind === 'page' ? `data:text/html,${encodeURIComponent('<style>body{font:16px system-ui}button{position:absolute;left:400px;top:200px}#other{top:400px}</style><button id="target">Target</button><button id="other">Other</button>')}` : `http://127.0.0.1:${vite.httpServer.address().port}/chat.html`),
      new Promise((_, reject) => { loadTimer = setTimeout(() => reject(new Error(`Timeout loading ${kind} (page ready: ${pageReady})`)), 10000); }),
    ]).finally(() => clearTimeout(loadTimer));
    win.webContents.debugger.attach('1.3');
    win.webContents.debugger.on('message', (_e, method, params) => { if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text); });
    await win.webContents.debugger.sendCommand('Runtime.enable');
  }
  await until(() => peer && pageReady && evaluate('document.querySelectorAll(".thread-item").length===2'), 'chat and page ready');
  page.webContents.send('page:open-thread', thread.threadId);
  await until(() => node('.th-panel'), 'thread opens');
  assert.equal(await stopVisible(), false, 'idle thread has no Stop button');

  // No decision or solver exists yet: Stop must still cancel the mistakenly sent turn.
  await draft('Mistaken request');
  await click('.th-panel .if-send');
  await until(() => starts().length === 1, 'first request sends');
  await until(stopVisible, 'Stop appears before routing finishes');
  assert.equal(await inspect('.th-panel .th-stop', 'function(){return this.previousElementSibling.classList.contains("th-state") && this.nextElementSibling.classList.contains("th-trash")}'), true, 'Stop sits between the working label and the trash icon');
  assert.equal(await node('.if-form .if-stop'), null, 'composer has no Stop button');
  await draft('Corrected request');
  const artifacts = path.join(root, 'results', 'thread-stop-smoke');
  mkdirSync(artifacts, { recursive: true });
  await new Promise(resolve => setTimeout(resolve, 100)); // let the header and draft paint before capturing
  writeFileSync(path.join(artifacts, 'panel.png'), (await page.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  await click('.th-panel .th-stop');
  await until(() => received.some(m => m.type === 'turn.cancel' && m.turnId === starts()[0].turnId) && stops().length === 1, 'routing and task cancelled');
  assert.deepEqual(await fieldState(), { value: 'Corrected request', start: 2, end: 5, focused: true }, 'Stop keeps draft, selection and focus');
  await click('.th-panel .if-send');
  await until(() => starts().length === 2, 'replacement sends immediately without waiting for the cancelled turn');
  assert.equal(starts()[1].text, 'Corrected request');
  assert.equal(starts()[1].threadId, thread.threadId);

  // Once handed off, the solver outlives the foreground turn. Stop must reach that solver too.
  const second = starts()[1];
  send({ type: 'decision', turnId: second.turnId, intent: 'task', estimateS: null, background: true, threadId: thread.threadId });
  thread.state = 'running'; send({ type: 'thread', thread }); done(second);
  await until(stopVisible, 'Stop remains available for background execution');
  await draft('Another correction');
  await click('.th-panel .th-stop');
  await until(() => stops().length === 2, 'background solver stopped');
  await until(async () => !(await stopVisible()), 'Stop hides when work ends');
  assert.equal((await fieldState()).value, 'Another correction');
  assert(await node('.th-panel .th-trash'), 'thread panel stays open');
  assert.equal(received.some(m => m.type === 'thread.delete'), false, 'Stop keeps the thread');
  await click('.th-panel .if-send');
  await until(() => starts().length === 3, 'thread accepts another message after a background stop');

  // Explicit Stop also clears held follow-ups for this thread, so they cannot restart it.
  await draft('Do not send this held follow-up');
  await click('.th-panel .if-send');
  await until(() => node('.th-held'), 'follow-up is held behind the active turn');
  assert.equal(starts().length, 3);
  await draft('Keep this unsent draft');
  await click('.th-panel .th-stop');
  await until(() => stops().length === 3, 'active turn stops');
  await until(async () => !(await node('.th-held')), 'stopped thread drops held follow-up');
  assert.equal((await fieldState()).value, 'Keep this unsent draft');
  done(starts()[2]); // a late completion of the stopped turn must not release the dropped follow-up
  await draft('Final corrected request');
  await click('.th-panel .if-send');
  await until(() => starts().length === 4, 'final correction sends');
  assert.equal(starts()[3].text, 'Final corrected request');
  done(starts()[3]);
  await until(async () => !(await stopVisible()), 'completed request hides Stop');
  assert.equal(starts().some(m => m.text === 'Do not send this held follow-up'), false);
  assert.equal(await evaluate('document.querySelector(".thread-item[data-thread-id=other-thread]").dataset.state'), 'running', 'other thread keeps running');
  assert.deepEqual(errors, []);
  console.log('Thread Stop smoke passed: stops routing and background work, preserves draft and focus, drops held follow-ups, sends corrections immediately.');
}

main().then(() => finish(0), error => { console.error(error); return finish(1); });
async function finish(code) {
  chat?.destroy(); page?.destroy();
  for (const client of sockets?.clients ?? []) client.terminate();
  sockets?.close(); await vite?.close();
  rmSync(userData, { recursive: true, force: true });
  app.exit(code);
}
