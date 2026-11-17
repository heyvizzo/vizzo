// Exercise typed feedback with microphone permission denied, using the real chat and IPC bridge.
// Run with npm run smoke:feedback. Uses local responses and no model or microphone calls.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const root = path.resolve(__dirname, '..');
const userData = mkdtempSync(path.join(tmpdir(), 'vizzo-feedback-smoke-'));
app.setPath('userData', userData);
let win, vite, sockets, queueState;
const starts = [], errors = [];
const annotation = {
  version: 1, id: 'feedback-smoke', pageUrl: 'https://example.test/', createdAt: 100,
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
  image: { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4xQAAAAASUVORK5CYII=', width: 1, height: 1 },
  strokes: [{ id: 'arrow', tool: 'arrow', points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] }],
  targetSamples: [],
};
ipcMain.on('hotkeys:get', event => { event.returnValue = null; });
ipcMain.on('chat-settings:get', event => { event.returnValue = JSON.stringify({ instant: false, alwaysListen: false }); });
ipcMain.on('queue:state', (_event, state) => { queueState = state; });
ipcMain.handle('attention:get', () => null);
ipcMain.handle('project:get', () => null);
ipcMain.handle('page:url', () => annotation.pageUrl);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    assert.deepEqual(errors, [], 'chat must not throw renderer exceptions');
    if (await fn()) return;
    await pause(40);
  }
  throw new Error(`Timeout: ${label}`);
}

async function main() {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const { createServer } = await import('vite');
  vite = await createServer({
    configFile: false, root: path.join(root, 'web'),
    server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [{ name: 'feedback-fixtures', configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url.startsWith('/api/')) return next();
        const pathname = new URL(req.url, 'http://localhost').pathname;
        const body = pathname === '/api/llm/notice' ? null
          : pathname === '/api/speech/engines' ? { engines: [] }
          : pathname === '/api/llm/providers' ? [] : {};
        req.resume();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      });
    } }],
  });
  sockets = new WebSocketServer({ noServer: true });
  vite.httpServer.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws') sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', ws => {
    const turns = new Map();
    const send = msg => ws.send(JSON.stringify(msg));
    ws.on('message', (data, binary) => {
      if (binary) return;
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') return send({ type: 'pong', id: msg.id, clientNow: msg.clientNow, serverNow: performance.now() });
      if (msg.type === 'turn.start') { starts.push(msg); turns.set(msg.turnId, msg); }
      if (msg.type !== 'turn.release') return;
      const start = turns.get(msg.turnId);
      send({ type: 'turn.done', turnId: msg.turnId, run: {
        runId: msg.turnId, turnId: msg.turnId, approach: start.config.approach,
        config: start.config, marks: {}, metrics: {}, transcript: start.text,
        pointing: [], voiceText: 'Feedback received.', solverText: '', usage: {},
        costUsd: 0, clock: { rttMs: 0, offsetMs: 0 }, annotation: start.annotation,
      } });
    });
  });
  await vite.listen();
  win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, 'dist-electron/preload.cjs'), sandbox: true,
    contextIsolation: true, backgroundThrottling: false,
  } });
  win.webContents.debugger.attach('1.3');
  win.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
  });
  void win.webContents.debugger.sendCommand('Runtime.enable');
  await win.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/chat.html`);
  await until(() => queueState && sockets.clients.size && win.webContents.executeJavaScript(
    "!document.querySelector('#enable').hidden && document.querySelector('#ptt').disabled"
  ), 'chat ready with microphone blocked');
  const comment = text => win.webContents.send('page:comment', { type: 'comment.send', text, sample: null, annotation });

  comment('First queued drawing');
  comment('Second queued drawing');
  await until(() => queueState.count === 2, 'drawings queued with Instant off');
  assert.equal(starts.length, 0, 'queue does not send early');
  win.webContents.send('queue:cmd', { type: 'send' });
  await until(() => starts.length === 2 && queueState.count === 0 && !queueState.sending, 'queue sends without audio');
  assert.deepEqual(starts.map(start => start.text), ['First queued drawing', 'Second queued drawing']);
  for (const start of starts) {
    assert.equal(start.config.silent, true, 'typed feedback requests a text response');
    assert.deepEqual(start.annotation, annotation, 'queued drawings retain their attachment');
  }

  win.webContents.send('queue:cmd', { type: 'instant', on: true });
  await until(() => queueState.instant, 'Instant enabled');
  comment('Instant drawing');
  await until(() => starts.length === 3, 'Instant drawing sends without audio');
  await until(() => win.webContents.executeJavaScript("!document.querySelector('.turn .user.pending')"), 'Instant response completes');
  assert.equal(queueState.count, 0, 'Instant drawing is never queued for missing audio');
  assert.equal(starts[2].config.silent, true);
  assert.deepEqual(starts[2].annotation, annotation, 'Instant drawing retains its attachment');
  assert.deepEqual(starts[2].annotation, annotation);
  assert.equal(starts[2].config.silent, true);
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('#ptt').disabled"), true, 'microphone stays disabled');
  assert.deepEqual(errors, []);
  console.log('Feedback smoke passed: queued and Instant drawings send in order with microphone access blocked.');
}

main().then(() => finish(0), error => { console.error(error); return finish(1); });
async function finish(code) {
  win?.destroy();
  for (const client of sockets?.clients ?? []) client.terminate();
  sockets?.close();
  await vite?.close();
  rmSync(userData, { recursive: true, force: true });
  app.exit(code);
}
