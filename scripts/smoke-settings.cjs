// Exercise the real Settings startup with isolated preferences and local API fixtures.
// No speech engines, model downloads, or external model calls are started.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const userData = mkdtempSync(path.join(tmpdir(), 'vizzo-settings-smoke-'));
app.setPath('userData', userData);
let win, vite;
const requests = [];
const errors = [];
const selection = { stt: 'local_whisperkit', tts: 'macos' };
const engines = [
  { kind: 'stt', engine: 'whisperkit', label: 'WhisperKit', state: 'ready' },
  { kind: 'tts', engine: 'macos', label: 'macOS voices', state: 'ready' },
];
const installs = [
  ...['apple', 'whisperkit', 'parakeet', 'moonshine'].map(engine => ({ kind: 'stt', engine })),
  ...['macos', 'kokoro', 'piper'].map(engine => ({ kind: 'tts', engine })),
].map(row => ({ ...row, installed: true, state: 'idle', builtin: ['apple', 'macos'].includes(row.engine) }));
ipcMain.on('hotkeys:get', event => { event.returnValue = null; });
ipcMain.on('chat-settings:get', event => {
  event.returnValue = JSON.stringify({ sttModel: selection.stt, ttsModel: selection.tts });
});
ipcMain.handle('instructions:get', () => ({ global: '', project: '', projectDir: null }));
ipcMain.handle('settings:get', () => ({ permissions: [], fields: [], values: {} }));

async function main() {
  await app.whenReady();
  const { createServer } = await import('vite');
  vite = await createServer({
    configFile: false, root: path.join(root, 'web'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'settings-fixtures', configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url.startsWith('/api/')) return next();
        requests.push(`${req.method} ${req.url}`);
        const pathname = new URL(req.url, 'http://localhost').pathname;
        const body = pathname === '/api/speech/engines' ? { selection, engines, installs }
          : pathname === '/api/speech/selection' ? { selection, engines }
          : pathname === '/api/tts/voices' ? {}
          : pathname === '/api/llm/selection' ? {}
          : [];
        req.resume();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      });
    } }],
  });
  await vite.listen();
  win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, 'dist-electron/preload.cjs'), sandbox: true,
    contextIsolation: true, backgroundThrottling: false,
  } });
  win.webContents.debugger.attach('1.3');
  win.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Runtime.exceptionThrown') {
      errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
    }
  });
  void win.webContents.debugger.sendCommand('Runtime.enable');
  await win.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/settings.html#stt`);
  const deadline = Date.now() + 10000;
  let statuses = [];
  while (Date.now() < deadline) {
    assert.deepEqual(errors, [], 'Settings must initialize without renderer exceptions');
    statuses = await win.webContents.executeJavaScript(
      "[...document.querySelectorAll('.install-text')].map(el => el.textContent)"
    );
    if (statuses.length === installs.length && statuses.every(text => text && !text.includes('Waiting'))) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(statuses.length, installs.length);
  assert.ok(statuses.every(text => text === 'Installed' || text === 'Built into macOS'), JSON.stringify(statuses));
  assert.ok(requests.includes('POST /api/speech/selection'), 'speech selection sent');
  assert.ok(requests.includes('GET /api/speech/engines'), 'speech polling started');
  assert.ok(requests.includes('GET /api/llm/providers'), 'initialization continued beyond speech');
  assert.ok(await win.webContents.executeJavaScript("document.querySelector('#health').textContent.length > 0"), 'dashboard rendered');
  console.log('Settings smoke passed: startup, speech polling, install status, and dashboard.');
}

main().then(() => finish(0), error => { console.error(error); return finish(1); });
async function finish(code) {
  win?.destroy();
  await vite?.close();
  rmSync(userData, { recursive: true, force: true });
  app.exit(code);
}
