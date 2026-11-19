// Exercise the real Settings startup with isolated preferences and local API fixtures.
// No speech engines, model downloads, or external model calls are started.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const userData = mkdtempSync(path.join(tmpdir(), 'vizzo-settings-smoke-'));
app.setPath('userData', userData);
let win, vite;
const requests = [];
const errors = [];
let permissions = [
  { id: 'microphone', name: 'Microphone', ok: true, summary: 'Allowed', instruction: 'The voice chat can hear you.' },
  { id: 'full-disk', name: 'Full Disk Access', ok: false, optional: true, summary: 'Not allowed',
    description: 'Needed only to import Safari cookies. Access lets Vizzo read Safari’s protected cookie file.',
    instruction: 'Enable Full Disk Access, then quit and reopen this app.', action: { id: 'open-full-disk', label: 'Open System Settings' } },
  { id: 'chrome-keychain', name: 'Chrome keychain', ok: false, optional: true, summary: 'Not allowed yet',
    description: 'Needed only to import Chrome cookies. Access lets Vizzo decrypt Chrome cookies using Chrome Safe Storage.',
    instruction: 'Choose Always Allow when macOS asks.', action: { id: 'allow-keychain', label: 'Allow keychain access' } },
];
const importCalls = [];
let finishImport;
const selection = { stt: 'local_whisperkit', tts: 'macos' };
let savedChat = { sttModel: selection.stt, ttsModel: selection.tts };
const chatWrites = [];
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
  event.returnValue = JSON.stringify(savedChat);
});
ipcMain.on('chat-settings:save', (_event, json) => {
  const patch = JSON.parse(json);
  chatWrites.push(patch);
  savedChat = { ...savedChat, ...patch };
});
ipcMain.handle('instructions:get', () => ({ global: '', project: '', projectDir: null }));
ipcMain.handle('settings:get', () => ({ permissions, fields: [], values: {} }));
ipcMain.handle('settings:refresh', () => permissions);
ipcMain.handle('settings:allow-keychain', () => {
  permissions = permissions.map(row => row.id === 'chrome-keychain' ? { ...row, ok: true, summary: 'Allowed', action: undefined } : row);
  return permissions;
});
ipcMain.handle('cookies:import', (_event, browser) => {
  importCalls.push(browser);
  return new Promise(resolve => { finishImport = resolve; });
});

const evaluate = source => win.webContents.executeJavaScript(source);
async function waitFor(source, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    assert.deepEqual(errors, [], 'Settings must run without renderer exceptions');
    if (await evaluate(source)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(message);
}
async function screenshot(file) {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  writeFileSync(file, (await win.webContents.capturePage()).toPNG());
}

async function main() {
  await app.whenReady();
  const { createServer } = await import('vite');
  vite = await createServer({
    configFile: false, root: path.join(root, 'web'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'settings-fixtures',
      transformIndexHtml: () => [{ tag: 'style', children: readFileSync(path.join(root, 'dist-electron/shell/theme.css'), 'utf8'), injectTo: 'head-prepend' }],
      configureServer(server) {
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
  win = new BrowserWindow({ show: false, width: 920, height: 760, webPreferences: {
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
  await waitFor("document.querySelector('#summary').textContent.includes('1 of 1 required permission granted')", 'Dashboard counts only the microphone');
  assert.ok(!(await evaluate("document.querySelector('#health').textContent")).match(/Full Disk Access|Chrome keychain/), 'optional permissions do not need attention');

  await evaluate("location.hash = '#debugging'");
  await waitFor("location.hash === '#preferences' && !document.querySelector('#section-preferences').hidden", 'Legacy link opens Preferences');
  assert.equal(await evaluate("document.querySelector('.sidebar [aria-current=page]').textContent"), 'Preferences');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#section-preferences h3')].map(heading => heading.textContent)"), ['General preferences', 'Debugging', 'Traces']);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#section-preferences h3 + .card input')].map(box => box.id)`),
    ['show-full-answers', 'show-solver-session', 'git-source-control']);
  assert.equal(await evaluate("document.querySelector('#show-solver-session').checked"), false);
  assert.equal(await evaluate("document.querySelector('#git-source-control').checked"), true);
  assert.match(await evaluate("document.querySelector('#summary .summary-row[title=\"Go to Preferences\"] .summary-text').textContent"), /Solver session off · Git source control on/);

  savedChat.autoCommitMessage = false; // Changes saved this while Settings was open.
  await evaluate("document.querySelector('#show-solver-session').click()");
  await waitFor("document.querySelector('#summary .summary-row[title=\"Go to Preferences\"] .summary-text').textContent.includes('Solver session on')", 'Dashboard follows the Solver session toggle');
  assert.equal(savedChat.showSolverSession, true);
  assert.equal(savedChat.showDebug, false);
  await evaluate("location.hash = '#models'");
  await waitFor("!document.querySelector('#section-models').hidden && !document.querySelector('#git-models').hidden", 'Git model picker is visible by default');
  const commitModel = () => evaluate(`({
    tier: document.querySelector('#commit-message-tier').value,
    label: document.querySelector('#commit-message-timeout-label').textContent,
    seconds: document.querySelector('#commit-message-timeout').valueAsNumber,
  })`);
  const selectCommitModel = value => evaluate(`{
    const tier = document.querySelector('#commit-message-tier');
    tier.value = ${JSON.stringify(value)};
    tier.dispatchEvent(new Event('change'));
  }`);
  const editTimeout = value => evaluate(`{
    const input = document.querySelector('#commit-message-timeout');
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input'));
  }`);
  assert.deepEqual(await commitModel(), { tier: 'fast', label: 'Fast timeout (seconds)', seconds: 15 });
  await editTimeout('24');
  await waitFor("JSON.parse(window.shell.chatSettings.get()).commitMessageTimeoutSeconds.fast === 24", 'Fast timeout saves');
  await selectCommitModel('smart');
  await waitFor("JSON.parse(window.shell.chatSettings.get()).commitMessageTier === 'smart'", 'Smart model choice is sent to desktop settings');
  assert.deepEqual(await commitModel(), { tier: 'smart', label: 'Smart timeout (seconds)', seconds: 60 });
  await editTimeout('82');
  await waitFor("JSON.parse(window.shell.chatSettings.get()).commitMessageTimeoutSeconds.smart === 82", 'Smart timeout saves');
  for (const value of ['', '0', '1.5', '14401']) {
    await editTimeout(value);
    assert.equal(await evaluate("document.querySelector('#commit-message-timeout').getAttribute('aria-invalid')"), 'true');
    assert.equal(await evaluate("document.querySelector('#commit-message-timeout-error').hidden"), false);
    assert.deepEqual(savedChat.commitMessageTimeoutSeconds, { fast: 24, smart: 82 });
  }
  await evaluate("document.querySelector('#commit-message-timeout').dispatchEvent(new FocusEvent('blur'))");
  assert.deepEqual(await commitModel(), { tier: 'smart', label: 'Smart timeout (seconds)', seconds: 82 });
  assert.equal(await evaluate("document.querySelector('#commit-message-timeout-error').hidden"), true);
  await selectCommitModel('fast');
  assert.deepEqual(await commitModel(), { tier: 'fast', label: 'Fast timeout (seconds)', seconds: 24 });
  await selectCommitModel('smart');
  await waitFor("JSON.parse(window.shell.chatSettings.get()).commitMessageTier === 'smart'", 'Restoring Smart saves its selection');
  assert.deepEqual(await commitModel(), { tier: 'smart', label: 'Smart timeout (seconds)', seconds: 82 });
  assert.equal(savedChat.gitSourceControl, true);
  assert.equal(savedChat.commitMessageTier, 'smart');
  assert.equal(savedChat.autoCommitMessage, false);
  assert.ok(chatWrites.every(patch => !Object.hasOwn(patch, 'autoCommitMessage')));

  await evaluate("location.hash = '#preferences'");
  await waitFor("!document.querySelector('#section-preferences').hidden", 'Preferences reopens');
  await evaluate("document.querySelector('#git-source-control').click()");
  await waitFor("document.querySelector('#git-models').hidden && JSON.parse(window.shell.chatSettings.get()).gitSourceControl === false", 'Disabling Git hides its model picker');
  assert.equal(savedChat.gitSourceControl, false);
  assert.equal(savedChat.commitMessageTier, 'smart');
  assert.match(await evaluate("document.querySelector('#summary').textContent"), /Git source control off/);
  const reloaded = once(win.webContents, 'did-finish-load');
  win.webContents.reload();
  await reloaded;
  await waitFor("!document.querySelector('#section-preferences').hidden && document.querySelector('#show-solver-session').checked && !document.querySelector('#git-source-control').checked && document.querySelector('#git-models').hidden && document.querySelector('#commit-message-tier').value === 'smart'", 'Solver session, the saved Git opt-out and the model choice survive reopening Settings');
  await evaluate("document.querySelector('#git-source-control').click()");
  await waitFor("!document.querySelector('#git-models').hidden && JSON.parse(window.shell.chatSettings.get()).gitSourceControl === true", 'Re-enabling Git restores its model picker');
  await evaluate("location.hash = '#models'");
  await waitFor("!document.querySelector('#section-models').hidden", 'Models reopens');
  assert.deepEqual(await commitModel(), { tier: 'smart', label: 'Smart timeout (seconds)', seconds: 82 });
  await selectCommitModel('fast');
  assert.deepEqual(await commitModel(), { tier: 'fast', label: 'Fast timeout (seconds)', seconds: 24 });

  await evaluate("location.hash = '#cookies'");
  await waitFor("!document.querySelector('#section-cookies').hidden", 'Browser cookies opens');
  const cookieState = () => evaluate("Object.fromEntries([...document.querySelectorAll('#cookies button[data-browser]')].map(button => [button.dataset.browser, button.disabled]))");
  assert.deepEqual(await cookieState(), { chrome: true, safari: true, firefox: false });
  assert.ok(await evaluate("!document.querySelector('#cookies-chrome-permission').hidden && document.querySelector('#cookies-chrome-permission').textContent.includes('decrypt')"), 'Chrome explains why it is disabled');
  assert.ok(await evaluate("!document.querySelector('#cookies-safari-permission').hidden && document.querySelector('#cookies-safari-permission').textContent.includes('Full Disk Access')"), 'Safari explains why it is disabled');
  await evaluate("document.querySelector('#cookies-chrome-permission a').click()");
  await waitFor("!document.querySelector('#section-permissions').hidden", 'disabled import links to Permissions');
  assert.equal(await evaluate("document.querySelectorAll('#permissions .optional').length"), 2);
  assert.equal(await evaluate("document.querySelectorAll('#permissions .permission-description').length"), 2);
  await evaluate("[...document.querySelectorAll('#permissions button')].find(button => button.textContent === 'Allow keychain access').click()");
  await waitFor("!document.querySelector('#cookies button[data-browser=chrome]').disabled", 'keychain approval enables Chrome');
  assert.deepEqual(await cookieState(), { chrome: false, safari: true, firefox: false });
  assert.ok(await evaluate("document.querySelector('#cookies-chrome-permission').hidden"), 'enabled import hides its blocker');

  await evaluate("location.hash = '#cookies'");
  await waitFor("!document.querySelector('#section-cookies').hidden", 'Browser cookies reopens');
  await evaluate("document.querySelector('#cookies button[data-browser=chrome]').click()");
  await waitFor("[...document.querySelectorAll('#cookies button')].every(button => button.disabled)", 'imports prevent overlapping cookie actions');
  assert.deepEqual(importCalls, ['chrome']);
  finishImport({ imported: 1, failed: 0, message: 'Imported 1 cookie from Chrome.' });
  await waitFor("document.querySelector('#cookies-status').textContent === 'Imported 1 cookie from Chrome.' && !document.querySelector('#cookies button[data-browser=chrome]').disabled", 'import completes');
  assert.deepEqual(await cookieState(), { chrome: false, safari: true, firefox: false }, 'completed import preserves Safari permission gate');

  permissions = permissions.map(row => row.id === 'full-disk' ? { ...row, ok: true, summary: 'Allowed', action: undefined } : row);
  await evaluate("location.hash = '#permissions'");
  await waitFor("!document.querySelector('#section-permissions').hidden", 'Permissions reopens');
  await evaluate("document.querySelector('#refresh').click()");
  await waitFor("!document.querySelector('#cookies button[data-browser=safari]').disabled", 'refresh enables Safari after permission is granted');
  assert.deepEqual(await cookieState(), { chrome: false, safari: false, firefox: false });
  assert.ok(await evaluate("document.querySelector('#cookies-safari-permission').hidden"));

  permissions = permissions.map(row => ({ ...row, ok: false, summary: 'Not allowed' }));
  await evaluate("document.querySelector('#refresh').click()");
  await waitFor("document.querySelector('#health').textContent.includes('Microphone: Not allowed')", 'microphone denial still needs attention');
  assert.ok(!(await evaluate("document.querySelector('#health').textContent")).match(/Full Disk Access|Chrome keychain/));
  assert.deepEqual(await cookieState(), { chrome: true, safari: true, firefox: false }, 'revoked cookie permissions disable imports again');
  if (process.env.SETTINGS_SCREENSHOT) {
    await screenshot(`${process.env.SETTINGS_SCREENSHOT}.permissions.png`);
  }
  await evaluate("location.hash = '#cookies'");
  await waitFor("!document.querySelector('#section-cookies').hidden", 'Browser cookies shows revoked permissions');
  if (process.env.SETTINGS_SCREENSHOT) {
    await screenshot(process.env.SETTINGS_SCREENSHOT);
  }
  assert.deepEqual(errors, []);
  console.log('Settings smoke passed: startup, speech polling, General preferences, persisted Git opt-out and model choice, Dashboard requirements, permission explanations, cookie gates, navigation, and permission changes.');
}

main().then(() => finish(0), error => { console.error(error); return finish(1); });
async function finish(code) {
  win?.destroy();
  await vite?.close();
  rmSync(userData, { recursive: true, force: true });
  app.exit(code);
}
