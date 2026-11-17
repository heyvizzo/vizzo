// Exercise real chat rendering with segment updates and partials arriving after stt.final.
// Run: npm run build:electron && npx electron scripts/smoke-transcript.cjs
// Local fixtures only; no microphone or model calls.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const root = path.resolve(__dirname, '..');
const userData = mkdtempSync(path.join(tmpdir(), 'vizzo-transcript-smoke-'));
app.setPath('userData', userData);
let win, vite, sockets, peer, active;
const errors = [];
ipcMain.on('hotkeys:get', e => { e.returnValue = null; });
ipcMain.on('chat-settings:get', e => { e.returnValue = JSON.stringify({ instant: true, alwaysListen: false, showDebug: true }); });
ipcMain.handle('attention:get', () => null);
ipcMain.handle('project:get', () => null);
ipcMain.handle('page:url', () => 'https://example.test/');
const evaluate = source => win.webContents.executeJavaScript(source);
async function until(fn, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    assert.deepEqual(errors, [], 'chat must not throw renderer exceptions');
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timeout: ${label}`);
}
const send = msg => peer.send(JSON.stringify({ ...msg, turnId: active.turnId }));

async function main() {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const { createServer } = await import('vite');
  vite = await createServer({ configFile: false, root: path.join(root, 'web'), server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{
    name: 'transcript-fixtures', configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url.startsWith('/api/')) return next();
        req.resume();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url === '/api/llm/notice' ? null : req.url === '/api/speech/engines' ? { engines: [] } : req.url === '/api/llm/providers' ? [] : {}));
      });
    },
  }] });
  sockets = new WebSocketServer({ noServer: true });
  vite.httpServer.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws') sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', ws => {
    peer = ws;
    const turns = new Map();
    ws.on('message', (raw, binary) => {
      if (binary) return;
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', id: msg.id, clientNow: msg.clientNow, serverNow: performance.now() }));
      if (msg.type === 'turn.start') turns.set(msg.turnId, msg);
      if (msg.type === 'turn.release') active = turns.get(msg.turnId);
    });
  });
  await vite.listen();
  win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, 'dist-electron/preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false,
  } });
  win.webContents.debugger.attach('1.3');
  win.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
  });
  void win.webContents.debugger.sendCommand('Runtime.enable');
  await win.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/chat.html`);
  await until(() => peer && evaluate("!!document.querySelector('#compose textarea')"), 'chat connected');

  for (const withWords of [true, false]) {
    active = null;
    await evaluate('(() => { const field = document.querySelector("#compose textarea"); field.value = "Transcript fixture"; field.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#compose .if-send").click(); })()');
    await until(() => active, 'turn starts');
    const selector = `.turn[data-turn="${active.turnId}"]`;
    const read = () => evaluate(`(() => { const root = document.querySelector(${JSON.stringify(selector)}); return {
      text: root.querySelector('.user').firstChild.textContent,
      language: root.querySelector('.lang')?.textContent,
      annotated: root.querySelector('.annot').textContent,
      pending: root.querySelector('.user').classList.contains('pending'),
      decided: !root.querySelector('.badges').hidden,
    }; })()`);
    send({ type: 'stt.partial', text: 'Keep the prefix.' });
    await until(async () => (await read()).text === 'Keep the prefix.', 'first segment visible');
    const text = 'Keep the prefix. Update this button too.';
    send({ type: 'stt.partial', text });
    await until(async () => (await read()).text === text, 'combined partial visible');
    const words = withWords ? text.split(' ').map((text, i) => ({ text, start: i, end: i + 0.5 })) : [];
    send({ type: 'stt.final', text, words, language: 'en' });
    send({ type: 'pointing.resolved', targets: withWords ? [{ word: 'this', wordStart: 4, algorithm: 'dwellMode', sample: null, ref: 1, wordIndex: 4 }] : [] });
    send({ type: 'stt.partial', text: 'tail only' });
    send({ type: 'stt.partial', text: '' });
    // A following decision is an ordered fence: both late partials have reached the renderer.
    send({ type: 'decision', intent: 'answer', estimateS: null, background: false });
    await until(async () => (await read()).decided, 'all transcript events processed');
    assert.deepEqual(await read(), {
      text, language: 'en', pending: false, decided: true,
      annotated: withWords ? 'Keep the prefix. Update this [1] button too.' : '',
    }, 'late partials must preserve the full message, language and annotated transcript');
    send({ type: 'turn.done', run: {
      runId: active.turnId, turnId: active.turnId, approach: active.config.approach, config: active.config,
      marks: {}, metrics: {}, transcript: text, pointing: [], voiceText: '', solverText: '', usage: {}, costUsd: 0,
      clock: { rttMs: 0, offsetMs: 0 },
    } });
    await until(() => evaluate("!document.querySelector('#status').textContent.includes('Answering')"), 'turn completes');
  }
  console.log('Transcript smoke passed: combined messages and annotations survive late partials, with and without word timestamps.');
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
