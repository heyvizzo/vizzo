// Real sandboxed preloads, settings updates, closed-shadow panels and native clipboard; no model calls.
// Run: npm run build:electron && npx electron scripts/smoke-session-badges.cjs
const { app, BrowserWindow, ClipboardItem, clipboard, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const root = path.resolve(__dirname, '..');
const userData = mkdtempSync(path.join(tmpdir(), 'vizzo-session-badges-'));
app.setPath('userData', userData);
let chat, page, vite, sockets, peer, originalClipboard, pageReady = false, copyFailure = false;
const errors = [], received = [];
const releaseRequests = [], releases = [];
const continued = [];
let holdRelease = false, finishRelease;
async function releaseSession(id) {
  releaseRequests.push(id);
  if (holdRelease) await new Promise(resolve => { finishRelease = resolve; });
  releases.push(id);
}
const central = { provider: 'claude-code', id: '019aa6d1-1111-7222-8333-123456789abc', resumeCommand: "cd '/tmp/My project' && claude --resume 019aa6d1-1111-7222-8333-123456789abc" };
const native = { provider: 'codex', id: '019aa6d1-4444-7555-8666-abcdef123456', resumeCommand: 'cd /tmp/project && codex resume 019aa6d1-4444-7555-8666-abcdef123456' };
const thread = {
  threadId: 'vizzo-thread-id', pageUrl: 'data:text/html', title: 'the button', state: 'idle', intent: 'task',
  summary: '', unread: false, awaitingReply: false, createdAt: 0, lastInteractionAt: 0,
  anchor: { pageUrl: 'data:text/html', selector: '#target', domPath: 'body > #target', dataSource: null, label: 'Target', text: 'Target', role: null, tag: 'button', bounds: { x: 400, y: 200, width: 100, height: 40 } },
  messages: [{ id: 'm1', turnId: null, at: 0, role: 'assistant', kind: 'result', text: 'Done.' }], session: native,
};
ipcMain.on('hotkeys:get', e => { e.returnValue = null; });
ipcMain.on('chat-settings:get', e => { e.returnValue = JSON.stringify({ showDebug: false, alwaysListen: false }); });
ipcMain.handle('attention:get', () => null);
ipcMain.handle('project:get', () => null);
ipcMain.handle('page:url', () => thread.pageUrl);
ipcMain.handle('page:history-state', () => ({ back: false, forward: false }));
ipcMain.handle('page:state', () => ({ tFrom: null }));
ipcMain.handle('drawing:get', () => false);
ipcMain.handle('comment:get', () => false);
ipcMain.handle('session:release', (_e, id) => releaseSession(id));
ipcMain.handle('session:continue', (_e, id, context) => { continued.push({ id, context }); });
ipcMain.handle('clipboard:write', (e, text) => {
  assert([chat.webContents, page.webContents].includes(e.sender));
  if (copyFailure) throw new Error('Clipboard fixture failure');
  return clipboard.writeText(text);
});
ipcMain.on('page:cmd', (_e, cmd) => page.webContents.send('page:cmd', cmd));
ipcMain.on('page:thread', (_e, action) => chat.webContents.send('page:thread', action));
ipcMain.on('page:ready', () => { pageReady = true; });
const evaluate = source => chat.webContents.executeJavaScript(source);
async function until(fn, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    assert.deepEqual(errors, []);
    try { if (await fn()) return; }
    catch (e) {
      // Conversation and debugging updates replace the panel's children between CDP read calls.
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
  const walk = n => { shadows.push(...(n.shadowRoots ?? [])); for (const child of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(child); };
  walk(doc);
  for (const shadow of shadows) {
    const { nodeId } = await cdp('DOM.querySelector', { nodeId: shadow.nodeId, selector });
    if (nodeId) return nodeId;
  }
  return null;
}
async function inspect(selector, functionDeclaration) {
  const nodeId = await node(selector);
  assert(nodeId, `Missing ${selector}`);
  const { object } = await cdp('DOM.resolveNode', { nodeId });
  const result = await cdp('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, returnByValue: true });
  assert(!result.exceptionDetails);
  return result.result.value;
}
async function text(selector) {
  return await node(selector) ? inspect(selector, 'function(){return this.textContent}') : '';
}
async function click(selector) {
  const { x, y } = await inspect(selector, 'function(){ this.scrollIntoView({block:"nearest"}); const r=this.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; }');
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function main() {
  await app.whenReady();
  originalClipboard = await Promise.all((await clipboard.read()).map(async item => new ClipboardItem(
    Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))),
  )));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const { createServer } = await import('vite');
  vite = await createServer({ configFile: false, root: path.join(root, 'web'), server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{
    name: 'session-fixtures',
    transformIndexHtml: () => [{ tag: 'style', children: readFileSync(path.join(root, 'dist-electron/shell/theme.css'), 'utf8'), injectTo: 'head-prepend' }],
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (!req.url.startsWith('/api/')) return next();
      if (req.url === '/api/sessions/release') {
        let body = ''; for await (const chunk of req) body += chunk;
        await releaseSession(JSON.parse(body).sessionId);
        res.writeHead(204); res.end(); return;
      }
      if (req.url === '/api/sessions/continue') {
        let body = ''; for await (const chunk of req) body += chunk;
        const { sessionId, context } = JSON.parse(body);
        continued.push({ id: sessionId, context });
        res.writeHead(204); res.end(); return;
      }
      req.resume(); res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/llm/notice' ? null : req.url === '/api/speech/engines' ? { engines: [] } : req.url === '/api/llm/providers' ? [] : {}));
    }); },
  }] });
  sockets = new WebSocketServer({ noServer: true });
  vite.httpServer.on('upgrade', (req, socket, head) => { if (req.url === '/ws') sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws)); });
  sockets.on('connection', ws => {
    const turns = new Map();
    peer = ws;
    ws.send(JSON.stringify({ type: 'threads.snapshot', threads: [thread] }));
    ws.send(JSON.stringify({ type: 'conversation.session', session: central }));
    ws.send(JSON.stringify({ type: 'job', job: {
      jobId: 'completed-job', turnId: 'old-turn', approach: 'pipeline', intent: 'task', question: 'The earlier main-conversation task',
      estimateS: 12, state: 'done', spoken: 'Done.', detail: 'SPOKEN: Done.\n\nThe earlier result.', session: native,
    } }));
    ws.on('message', (data, binary) => {
      if (binary) return;
      const msg = JSON.parse(data.toString()); received.push(msg);
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', id: msg.id, clientNow: msg.clientNow, serverNow: performance.now() }));
      if (msg.type === 'turn.start') turns.set(msg.turnId, msg);
      if (msg.type === 'turn.release') {
        const start = turns.get(msg.turnId);
        ws.send(JSON.stringify({ type: 'turn.done', turnId: msg.turnId, run: {
          runId: msg.turnId, turnId: msg.turnId, approach: start.config.approach, config: start.config,
          marks: {}, metrics: {}, transcript: start.text, pointing: [], voiceText: 'A foreground answer.',
          solverText: 'SPOKEN: A foreground answer.', usage: {}, costUsd: 0, clock: { rttMs: 0, offsetMs: 0 }, session: central,
        } }));
      }
    });
  });
  await vite.listen();
  for (const kind of ['page', 'chat']) {
    const win = new BrowserWindow({ show: false, width: kind === 'page' ? 1000 : 480, height: 760, webPreferences: {
      preload: path.join(root, 'dist-electron', kind === 'page' ? 'page-preload.cjs' : 'preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false,
    } });
    if (kind === 'page') page = win; else chat = win;
    win.webContents.debugger.attach('1.3');
    win.webContents.debugger.on('message', (_e, method, params) => { if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text); });
    void win.webContents.debugger.sendCommand('Runtime.enable');
    await win.loadURL(kind === 'page' ? 'data:text/html,<style>body{background:%23f5f5f7;font:16px system-ui;padding:80px}button{margin:100px 300px}</style><h1>Session debugging</h1><button id="target">Target</button>' : `http://127.0.0.1:${vite.httpServer.address().port}/chat.html`);
  }
  await until(() => peer && pageReady && evaluate('!!document.querySelector("#conversation-session .session-badge")'), 'session reaches sidebar');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#conversation-session .session-info")).display'), 'none');
  await until(() => text('.th-bubble.fixed.th-job-result').then(t => t.includes('Done.')), 'completion appears at the orb without waiting for speech');
  await click('.th-bubble .th-job-open');
  const result = '.th-panel [data-key="job:completed-job"]';
  await until(() => node(result + ' details[open]'), 'the orb bubble opens its own task details');
  assert.equal(await text(result + ' .th-job-question'), 'The earlier main-conversation task');
  assert.equal(await text(result + ' .th-detail'), 'The earlier result.');
  await click('.th-close');
  page.webContents.send('page:open-thread', thread.threadId);
  await until(() => node('.th-panel'), 'thread panel opens');
  assert.equal(await node('.th-panel .session-info'), null, 'debug off hides native session');
  await evaluate('document.querySelector(".job-marker").click()');
  assert.equal(await evaluate('!!document.querySelector(".job .session-continue")'), true, 'completed tasks can be continued with debugging off');
  await evaluate('document.querySelector(".job .session-continue").click()');
  await until(() => continued.some(item => item.id === native.id && item.context === 'The earlier main-conversation task'), 'sidebar selects the completed native context');
  await evaluate('const field=document.querySelector("#compose textarea"); field.value="Earlier foreground question"; field.dispatchEvent(new Event("input", {bubbles:true})); document.querySelector("#compose .if-send").click()');
  await until(() => evaluate('!!document.querySelector(".turn .session-continue")'), 'completed foreground turn has continuation controls');
  await evaluate('document.querySelector(".turn .session-continue").click()');
  await until(() => continued.some(item => item.id === central.id && item.context === 'Earlier foreground question'), 'foreground turn selects its own saved context');
  chat.webContents.send('chat-settings:changed', JSON.stringify({ showDebug: false, showSolverSession: true }));
  await until(() => node('.th-panel .session-badge'), 'live solver-session setting shows thread session (details stay off)');
  assert.equal(await inspect('.th-panel .session-badge', 'function(){return this.textContent}'), `Codex · ${native.id}`);
  assert.equal(await inspect('.th-panel .session-badge', 'function(){return this.dataset.tip}'), 'Click to copy the resume command');
  assert(await node('.th-session-row .th-trash'), 'trash sits on the session row');
  assert.equal(await node('.th-head .th-trash'), null, 'header keeps only the title and close');
  assert.equal(await page.webContents.executeJavaScript('typeof navigator.clipboard'), 'undefined', 'fixture has no web clipboard');
  await clipboard.writeText('untouched until native release');
  holdRelease = true;
  await click('.th-panel .session-badge');
  await until(() => releaseRequests.includes(native.id), 'thread requests release');
  assert.equal(await clipboard.readText(), 'untouched until native release', 'command must not be copied before native close');
  assert.equal(await text('.session-copy-status'), 'Preparing resume command…');
  holdRelease = false; finishRelease();
  await until(async () => await clipboard.readText() === native.resumeCommand && releases.includes(native.id), 'native clipboard after release');
  assert.equal(await inspect('.session-copy-status', 'function(){return this.textContent}'), 'Resume command copied');
  await click('.th-close');
  await click('.th-orb');
  await until(() => text('.th-panel .session-badge').then(text => text.includes(central.id)), 'conversation orb gets its own native session');
  await until(() => node('.th-turn .session-actions .session-badge'), 'completed task session reaches conversation orb');
  const continuedBefore = continued.length;
  await click('.th-turn .session-continue');
  await until(() => continued.length > continuedBefore, 'orb selects the completed native context');
  assert.deepEqual(continued.at(-1), { id: native.id, context: 'The earlier main-conversation task' });
  await click('.th-turn .session-actions .session-badge');
  await until(async () => await clipboard.readText() === native.resumeCommand, 'completed task copies its own terminal resume command');
  await click('.th-panel .session-badge');
  await until(async () => await clipboard.readText() === central.resumeCommand, 'orb copies central command');
  await clipboard.writeText('untouched until sidebar release');
  holdRelease = true;
  const before = releaseRequests.length;
  await evaluate('document.querySelector("#conversation-session .session-badge").click()');
  await until(() => releaseRequests.length > before, 'sidebar requests release');
  assert.equal(await clipboard.readText(), 'untouched until sidebar release', 'sidebar waits for native close');
  holdRelease = false; finishRelease();
  await until(() => evaluate('document.querySelector("#conversation-session .session-copy-status").textContent.includes("copied")'), 'sidebar copies central command');
  copyFailure = true;
  await click('.th-panel .session-badge');
  await until(() => text('.th-panel .session-copy-status').then(text => text.includes("Couldn't copy")), 'clipboard failure is visible');
  copyFailure = false;
  const changed = { provider: 'grok', id: 'replacement-id', resumeCommand: 'cd /tmp/project && grok -r replacement-id' };
  peer.send(JSON.stringify({ type: 'conversation.session', session: changed }));
  await until(() => text('.th-panel .session-badge').then(text => text === 'Grok · replacement-id'), 'new native session replaces the previous one');
  chat.webContents.send('chat-settings:changed', JSON.stringify({ showDebug: true, showSolverSession: false }));
  await until(async () => !(await node('.th-panel .session-info')), 'disabling solver session removes badge from an open panel, even with details on');
  peer.send(JSON.stringify({ type: 'conversation.session', session: null }));
  chat.webContents.send('chat-settings:changed', JSON.stringify({ showDebug: false, showSolverSession: true }));
  await until(() => node('.th-panel .session-info[hidden]'), 'reset hides the session row');
  assert.equal(await text('.th-panel .session-info'), '', 'no placeholder when there is no session');
  await until(() => evaluate('document.querySelector("#conversation-session .session-info").hidden && document.querySelector("#conversation-session").textContent === ""'), 'sidebar hides the session row after reset');
  assert.equal(await node('.th-panel > .th-session-row .session-badge'), null);
  assert(await node('.th-turn .session-actions .session-badge'), 'completed task still has its own resume command');
  const artifacts = path.join(root, 'results', 'session-badges-smoke');
  mkdirSync(artifacts, { recursive: true });
  peer.send(JSON.stringify({ type: 'conversation.session', session: central }));
  await until(() => text('.th-panel > .th-session-row .session-badge').then(text => text.includes(central.id)), 'restore session for screenshot');
  await page.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await chat.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  writeFileSync(path.join(artifacts, 'conversation.png'), (await page.webContents.capturePage()).toPNG());
  writeFileSync(path.join(artifacts, 'sidebar.png'), (await chat.webContents.capturePage()).toPNG());
  await click('.th-close');
  page.webContents.send('page:open-thread', thread.threadId);
  await until(() => node('.th-panel .session-badge'), 'thread screenshot');
  await page.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  writeFileSync(path.join(artifacts, 'thread.png'), (await page.webContents.capturePage()).toPNG());
  console.log('Session badge smoke passed: foreground and background task continuation in both panels, native IDs and clipboard, release ordering, live debugging toggle, copy failure and reset.');
}
main().then(() => finish(0), error => { console.error(error); return finish(1); });
async function finish(code) {
  if (originalClipboard) await clipboard.write(originalClipboard);
  chat?.destroy(); page?.destroy();
  for (const client of sockets?.clients ?? []) client.terminate();
  sockets?.close(); await vite?.close();
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); app.exit(code);
}
