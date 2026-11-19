// A thread restored after the app was closed mid-run (server/threads/persist.ts): its marker and sidebar row say
// "interrupted", and Resume and Continue use the native follow-up path. Also exercises the panel's delete matrix.
// Exercises the native panel across reloads while typing and dictating with a fake microphone and server.
// Run: npm run smoke:thread-resume
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { once } = require('node:events');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { installThreadPanel } = require('../electron/threadPanel.ts');
const { installPageReload } = require('../electron/pageReload.ts');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const root = path.resolve(__dirname, '..');
const userData = mkdtempSync(path.join(tmpdir(), 'vizzo-thread-resume-'));
app.setPath('userData', userData);
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
let chat, page, vite, sockets, peer, queueState, pageReady = false;
let panelHost, stalledScript;
let stallPage = false, omitTarget = false;
let targetLeft = 45;
let lastInsertId;

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
ipcMain.handle('page:url', () => page.webContents.getURL());
ipcMain.handle('page:state', () => ({ tFrom: null }));
ipcMain.handle('page:history-state', () => ({ back: false, forward: false }));
ipcMain.handle('drawing:get', () => false);
ipcMain.handle('comment:get', () => false);
ipcMain.on('page:cmd', (_e, cmd) => {
  if (cmd.type === 'comment.insert') lastInsertId = cmd.dictation?.id;
  panelHost.command(cmd);
  if (cmd.surface !== 'panel') page.webContents.send('page:cmd', cmd);
});
ipcMain.on('page:thread', (_e, action) => chat?.webContents.send('page:thread', action));
ipcMain.on('page:comment', (_e, action) => chat?.webContents.send('page:comment', action));
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
const target = selector => selector.startsWith('.th-marker') || selector.startsWith('.th-orb') || selector.startsWith('.cm-') ? page.webContents : panelHost.view.webContents;
const cdp = (method, params = {}, selector = '.th-panel') => target(selector).debugger.sendCommand(method, params);
async function node(selector) {
  const { root: doc } = await cdp('DOM.getDocument', { depth: -1, pierce: true }, selector);
  const shadows = [];
  const walk = n => { shadows.push(...(n.shadowRoots ?? [])); for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(c); };
  walk(doc);
  for (const shadow of shadows) {
    const { nodeId } = await cdp('DOM.querySelector', { nodeId: shadow.nodeId, selector }, selector);
    if (nodeId) return nodeId;
  }
  return null;
}
async function inspect(selector, functionDeclaration, args = []) {
  const nodeId = await node(selector);
  assert(nodeId, `Missing ${selector}`);
  const { object } = await cdp('DOM.resolveNode', { nodeId }, selector);
  const result = await cdp('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue: true }, selector);
  assert(!result.exceptionDetails, result.exceptionDetails?.text);
  return result.result.value;
}
async function click(selector) {
  const { x, y } = await inspect(selector, 'function(){const r=this.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}');
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, selector);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, selector);
}
async function dragPanel(selector, dx, dy) {
  const { x, y } = await inspect(selector, 'function(){const r=this.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}');
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx, y: y + dy, button: 'left', buttons: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
}
const choices = () => inspect('.th-delete-actions', 'function(){return [...this.children].map(b => b.textContent)}');
const focused = () => inspect('.th-panel', 'function(){const active=this.getRootNode().activeElement;return active?.textContent || active?.getAttribute("aria-label")}');
async function pressKey(key, shift = false) {
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
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(wc === chat?.webContents && permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => wc === chat?.webContents && permission === 'media');
  const { createServer } = await import('vite');
  vite = await createServer({ configFile: false, root: path.join(root, 'web'), server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'thread-resume-fixtures',
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url === '/gate.js') {
        res.setHeader('Content-Type', 'text/javascript');
        if (stallPage) { stalledScript = res; return; }
        return res.end('');
      }
      if (req.url.startsWith('/target')) {
        res.setHeader('Content-Type', 'text/html');
        return res.end(`<script src="/gate.js"></script><script type="module" src="/@vite/client"></script><style>button{position:absolute;left:${targetLeft}%;width:20%;top:180px;height:40px}</style>${omitTarget ? '' : '<button id="target">Target</button>'}`);
      }
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
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  thread.pageUrl = thread.anchor.pageUrl = base + '/target.html';
  thread.anchor.point = { x: 425, y: 210 }; // quarter of the original button's width and height
  for (const kind of ['page', 'chat']) {
    const win = new BrowserWindow({ show: false, width: kind === 'page' ? 1000 : 480, height: 760, webPreferences: {
      additionalArguments: kind === 'page' ? ['--vizzo-thread-panel'] : [],
      preload: path.join(root, 'dist-electron', kind === 'page' ? 'page-preload.cjs' : 'preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false,
    } });
    if (kind === 'page') {
      page = win;
      panelHost = installThreadPanel(win, win.webContents, () => {
        const [width, height] = win.getContentSize();
        return { x: 0, y: 0, width, height };
      }, path.join(root, 'dist-electron'), (channel, ...args) => chat?.webContents.send(channel, ...args), () => assert.fail('unexpected Commit action'));
      panelHost.setChangesStatus(null, true);
      const panel = panelHost.view.webContents;
      panel.debugger.attach('1.3');
      panel.debugger.on('message', (_e, method, params) => { if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.text); });
      await panel.debugger.sendCommand('Runtime.enable');
      const sendUrl = () => chat?.webContents.send('page:url', page.webContents.getURL());
      win.webContents.on('did-navigate', sendUrl);
      installPageReload(win.webContents, () => {
        pageReady = true;
        win.webContents.send('changes:page-status', null, true);
        sendUrl();
      }, down => chat?.webContents.send('ptt', down));
    } else chat = win;
    let loadTimer;
    await Promise.race([
      win.loadURL(kind === 'page' ? thread.pageUrl : base + '/chat.html'),
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
    await pressKey('Tab', true);
    assert.equal(await focused(), 'Cancel');
    await pressKey('Escape');
    assert.equal(await node('.th-foot'), null);
    assert.equal(await focused(), 'Delete');
  }
  assert.equal(deletes().length, 0, 'cancelled dialogs leave the thread alone');

  // A late response for an abandoned preview cannot replace the current dialog.
  await click('.th-trash');
  await until(() => previews().length === 5, 'preview awaiting reply');
  await pressKey('Escape');
  await click('.th-trash');
  await until(() => previews().length === 6, 'new preview awaiting reply');
  reply(previews()[4], 'working');
  reply(previews()[5], 'complete');
  await until(() => node('.th-delete-actions .th-danger'), 'new preview ready');
  assert.deepEqual(await choices(), matrix[1][2]);
  assert.equal(await focused(), 'Commit and delete');
  await pressKey('Enter');
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
  await pressKey('Enter');
  await until(() => queueState.count === 0, 'local delete removes feedback grouped at the element');
  assert.equal(previews().length, 6, 'queued delete never requests a server preview');
  assert.equal(deletes().length, 1, 'queued delete never sends a server mutation');
  assert.equal(starts().length, 0);

  // Start a fresh thread for the reload checks after the deletion and queued-feedback cases.
  chat.webContents.send('queue:cmd', { type: 'instant', on: true });
  await until(() => queueState.instant, 'Instant enabled');
  Object.assign(thread, { threadId: 'thread-reload', state: 'running', incomplete: false, canContinue: false });
  send({ type: 'thread', thread });
  await until(() => node('.th-marker[data-state=running]'), 'reload thread shown');
  await click('.th-marker[data-state=running]');
  await until(() => node('.th-panel textarea'), 'reload thread opened');

  async function reload() {
    const loaded = once(page.webContents, 'did-finish-load');
    page.webContents.reload();
    await loaded;
  }
  const marker = () => inspect('.th-marker', 'function(){const r=this.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}');
  async function relativePoint() {
    return page.webContents.executeJavaScript('(()=>{const r=document.querySelector("#target").getBoundingClientRect();return {x:r.left+r.width/4,y:r.top+r.height/4}})()');
  }
  const oldMarker = await marker();
  const oldPanel = panelHost.view.getBounds();
  page.setContentSize(800, 700);
  await until(async () => {
    const point = await marker(), expected = await relativePoint(), bounds = panelHost.view.getBounds();
    return Math.abs(point.x - expected.x) < 1 && Math.abs(point.y - expected.y) < 1
      && Math.abs(bounds.x - oldPanel.x - (point.x - oldMarker.x)) < 2 && bounds.x !== oldPanel.x;
  }, 'marker holds its fractional anchor and native panel follows a resize');
  const pinned = await marker();
  const initial = panelHost.view.getBounds();
  await dragPanel('.th-panel .th-title', 24, 14);
  await until(() => Math.abs(panelHost.view.getBounds().x - initial.x - 24) < 2, 'native panel header drag');
  const moved = panelHost.view.getBounds();
  assert(Math.abs(moved.y - initial.y - 14) < 2);
  await dragPanel('.th-panel .th-resize-handle[data-corner="se"]', 30, 24);
  await until(() => Math.abs(panelHost.view.getBounds().width - moved.width - 30) < 2, 'native panel corner resize');
  const resized = panelHost.view.getBounds();
  assert(Math.abs(resized.height - moved.height - 24) < 2);
  const afterDrag = await marker();
  assert(Math.hypot(afterDrag.x - pinned.x, afterDrag.y - pinned.y) < 0.1, 'dragging and resizing the panel leaves its marker pinned');
  await draft('A typed draft');
  await inspect('.th-panel textarea', 'function(){window.originalField=this}');
  const before = panelHost.view.getBounds();
  stallPage = true;
  targetLeft = 40;
  const loaded = once(page.webContents, 'did-finish-load');
  vite.ws.send({ type: 'full-reload', path: '/target.html' });
  await until(() => !!stalledScript, 'Vite reload is blocked inside the replacement document');
  assert(panelHost.view.getVisible(), 'panel remains visible during reload');
  assert.deepEqual(panelHost.view.getBounds(), before);
  assert.deepEqual(await fieldState(), { value: 'A typed draft', start: 2, end: 5, focused: true });
  await cdp('Input.insertText', { text: 'new' });
  assert.equal((await fieldState()).value, 'A newed draft', 'typing works while the replacement page is blocked');
  stallPage = false; stalledScript.end(''); stalledScript = null;
  await loaded;
  assert(await inspect('.th-panel textarea', 'function(){return this===window.originalField}'), 'same DOM editor throughout reload');
  await until(async () => {
    const point = await marker(), expected = await relativePoint();
    return Math.abs(point.x - expected.x) < 1 && point.x !== pinned.x
      && Math.abs(panelHost.view.getBounds().x - before.x - (point.x - pinned.x)) < 2;
  }, 'panel reattaches to the moved element with its chosen offset');
  assert.equal(starts().length, 0, 'reload does not submit the draft');
  await draft('A typed draft');
  await until(() => evaluate('!document.querySelector("#ptt").disabled'), 'fake microphone ready');
  await click('.th-panel .if-rec');
  await until(() => starts().some(m => m.config.approach === 'cursor-only'), 'dictation started');
  const voiceId = starts().find(m => m.config.approach === 'cursor-only').turnId;
  await until(() => received.some(m => m.type === 'turn.audioStart' && m.turnId === voiceId), 'dictation capturing');
  send({ type: 'stt.partial', turnId: voiceId, text: 'spoken' });
  await until(async () => (await inspect('.th-panel .if-partial', 'function(){return this.textContent}')) === 'spoken', 'partial delivered');
  await reload();
  await until(() => node('.th-panel .if-form.rec'), 'same recording on the open mic');
  assert.equal(await inspect('.th-panel .if-partial', 'function(){return this.textContent}'), 'spoken');
  await click('.th-panel .if-rec');
  await until(() => received.some(m => m.type === 'turn.release' && m.turnId === voiceId), 'recording released');
  // Final words reach the same field even while the replacement document is blocked.
  stallPage = true;
  const transcribingReload = reload();
  await until(() => !!stalledScript, 'reload during transcription');
  send({ type: 'stt.final', turnId: voiceId, text: 'spoken words', words: [] });
  await until(async () => lastInsertId === voiceId && (await fieldState()).value === 'A spoken words ed draft', 'final inserted during reload');
  stallPage = false; stalledScript.end(''); stalledScript = null;
  await transcribingReload;
  await reload();
  assert.equal((await fieldState()).value, 'A spoken words ed draft', 'transcript inserted once');
  await click('.th-panel .if-send');
  await until(() => starts().at(-1).text === 'A spoken words ed draft', 'reply sent after reload');
  assert.equal(starts().at(-1).threadId, thread.threadId);
  await reload();
  await until(() => node('.th-panel textarea'), 'thread stays open after sending');
  assert.equal((await fieldState()).value, '', 'sent draft stays cleared');
  done(starts().at(-1));
  await inspect('.th-panel textarea', 'function(){this.focus()}');
  const key = { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key, modifiers: 2 });
  await until(() => starts().filter(m => m.config.approach === 'cursor-only').length === 2, 'held shortcut starts dictation');
  const heldId = starts().at(-1).turnId;
  await until(() => received.some(m => m.type === 'turn.audioStart' && m.turnId === heldId), 'held mic capturing');
  await reload();
  await until(() => node('.th-panel .if-form.rec'), 'held key keeps recording across reload');
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  await until(() => received.some(m => m.type === 'turn.release' && m.turnId === heldId), 'key release in the panel ends the hold');
  send({ type: 'stt.final', turnId: heldId, text: 'held across reload', words: [] });
  await until(async () => (await fieldState()).value === 'held across reload', 'hold-to-talk transcript in its original field');
  await click('.th-panel .th-close');
  await reload();
  await until(() => node('.th-marker'), 'markers reloaded');
  assert.equal(await node('.th-panel'), null, 'explicitly closed panel stays closed');
  page.webContents.send('page:open-thread', thread.threadId);
  await until(() => panelHost.view.getVisible(), 'thread reopened on the original page');
  await page.loadURL(thread.pageUrl + '?other');
  await until(() => !panelHost.view.getVisible(), 'opening a different page dismisses its thread panel');
  await page.loadURL(thread.pageUrl);
  await until(() => node('.th-marker'), 'returned to the original page');
  await click('.th-marker');
  await until(() => node('.th-panel textarea'), 'opened thread before deletion');
  const lastPosition = panelHost.view.getBounds();
  omitTarget = true;
  await reload();
  await until(() => node('.th-marker.faded'), 'target removed from the document');
  assert(panelHost.view.getVisible(), 'thread remains open if its element disappears');
  assert.deepEqual(panelHost.view.getBounds(), lastPosition);
  send({ type: 'thread.removed', threadId: thread.threadId });
  await until(() => !panelHost.view.getVisible(), 'deleting the thread dismisses its panel');
  omitTarget = false;
  await reload();
  page.webContents.send('page:comment-at', { x: 390, y: 195 });
  await until(() => node('.cm-bubble textarea'), 'comment composer opened');
  await inspect('.cm-bubble textarea', 'function(){this.value="Unsent comment";this.dispatchEvent(new Event("input"))}');
  await reload();
  await until(() => node('.cm-bubble textarea'), 'comment bubble restored');
  assert.equal(await inspect('.cm-bubble textarea', 'function(){return this.value}'), 'Unsent comment');
  await page.loadURL(thread.pageUrl + '?other');
  await until(() => node('.th-orb'), 'different page initialized');
  assert.equal(await node('.cm-bubble'), null, 'private draft stays on the original page');
  assert.deepEqual(errors, []);
  console.log('Thread resume and live reload passed, including typed drafts, mic capture and late transcripts.');
}

main().then(() => finish(0), error => { console.error(error); return finish(1); });
async function finish(code) {
  chat?.destroy(); page?.destroy();
  for (const client of sockets?.clients ?? []) client.terminate();
  sockets?.close(); await vite?.close();
  rmSync(userData, { recursive: true, force: true });
  app.exit(code);
}
