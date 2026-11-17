// Render streamed, final-only and background-job answers in the real chat sidebar.
// Run: npm run build:electron && npx electron scripts/smoke-markdown.cjs
// Local fixtures only; no microphone or model calls. Screenshots: results/markdown-smoke/.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const root = path.resolve(__dirname, '..');
const userData = mkdtempSync(path.join(tmpdir(), 'vizzo-markdown-smoke-'));
app.setPath('userData', userData);
let win, vite, sockets, peer, active, conversation;
const errors = [];
ipcMain.on('hotkeys:get', e => { e.returnValue = null; });
ipcMain.on('chat-settings:get', e => { e.returnValue = JSON.stringify({ instant: true, alwaysListen: false, showFullAnswers: true }); });
ipcMain.on('page:cmd', (_e, cmd) => { if (cmd.type === 'conversation') conversation = cmd.entries; });
ipcMain.handle('attention:get', () => null);
ipcMain.handle('project:get', () => null);
ipcMain.handle('page:url', () => 'https://example.test/');
const evaluate = source => win.webContents.executeJavaScript(source);
const send = msg => peer.send(JSON.stringify(msg));
async function until(fn, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    assert.deepEqual(errors, [], 'chat must not throw renderer exceptions');
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timeout: ${label}`);
}
async function startTurn() {
  active = null;
  await evaluate(`(() => {
    const field = document.querySelector('#compose textarea');
    field.value = 'Show the full answer';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#compose .if-send').click();
  })()`);
  await until(() => active, 'turn starts');
  return active.turnId;
}
function finishTurn(solverText) {
  send({ type: 'turn.done', turnId: active.turnId, run: {
    runId: active.turnId, turnId: active.turnId, approach: active.config.approach, config: active.config,
    marks: {}, metrics: {}, transcript: active.text, pointing: [], voiceText: 'Here is the answer.',
    solverText, usage: {}, costUsd: 0, clock: { rttMs: 0, offsetMs: 0 },
  } });
}

async function main() {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const { createServer } = await import('vite');
  let themeCss;
  vite = await createServer({ configFile: false, root: path.join(root, 'web'), server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{
    name: 'markdown-fixtures',
    transformIndexHtml: () => [{ tag: 'style', children: themeCss(), injectTo: 'head-prepend' }],
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url.startsWith('/api/')) return next();
        req.resume();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url === '/api/llm/notice' ? null : req.url === '/api/speech/engines' ? { engines: [] } : req.url === '/api/llm/providers' ? [] : {}));
      });
    },
  }] });
  ({ themeCss } = await vite.ssrLoadModule(path.join(root, 'shared/theme.ts')));
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
  win = new BrowserWindow({ show: false, width: 420, height: 900, webPreferences: {
    preload: path.join(root, 'dist-electron/preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false,
  } });
  win.webContents.debugger.attach('1.3');
  win.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
  });
  void win.webContents.debugger.sendCommand('Runtime.enable');
  await win.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/chat.html`);
  await until(() => peer && evaluate("!!document.querySelector('#compose textarea')"), 'chat connected');

  const turnId = await startTurn();
  const selector = `.turn[data-turn="${turnId}"] details.detail`;
  const prefix = 'SPOKEN: Here is the answer.\n\n';
  const code = 'const text = "<tag>";\n    return text; // ' + 'long line '.repeat(20);
  const markdown = '# Overview\n\n**Streamed** answer with `inline code`, *emphasis* and ~~old text~~.\n\n'
    + '- First item\n  - Nested item\n- Second item\n\n3. Third step\n4. Fourth step\n\n'
    + '> A quoted note.\n\n```ts\n' + code + '\n```\n\n'
    + '| File | Status |\n| --- | --- |\n| `main.ts` | **Fixed** |\n\n---\n\n'
    + '[Docs](https://example.test/docs)\n\n<img src=x onerror="window.markdownExecuted = true">';
  send({ type: 'solver.text', turnId, delta: prefix });
  send({ type: 'solver.text', turnId, delta: '# Overview\n\n**Stream' });
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify(selector + ' h1')})`), 'streamed Markdown renders');
  await evaluate(`document.querySelector(${JSON.stringify(selector + ' > summary')}).click()`);
  send({ type: 'solver.text', turnId, delta: markdown.slice('# Overview\n\n**Stream'.length) });
  await until(() => evaluate(`document.querySelector(${JSON.stringify(selector + ' strong')})?.textContent === 'Streamed'`), 'split emphasis completes');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).open`), true, 'streaming keeps Full answer expanded');
  finishTurn(prefix + markdown);
  await until(() => conversation?.find(e => e.id === turnId)?.detail === markdown, 'page panel receives original Markdown');

  const rendered = await evaluate(`(() => {
    const d = document.querySelector(${JSON.stringify(selector)});
    return {
      heading: d.querySelector('h1')?.textContent,
      strong: d.querySelector('strong')?.textContent,
      inline: d.querySelector('p code')?.textContent,
      nested: d.querySelector('ul ul li')?.textContent,
      ordered: d.querySelector('ol')?.start,
      quote: d.querySelector('blockquote')?.textContent,
      code: d.querySelector('pre code')?.textContent,
      table: d.querySelector('tbody td')?.textContent,
      link: d.querySelector('.md-link')?.title,
      emphasis: !!d.querySelector('em'), strike: !!d.querySelector('del'), rule: !!d.querySelector('hr'),
      unsafe: !!d.querySelector('img, script') || !!window.markdownExecuted,
    };
  })()`);
  assert.deepEqual(rendered, {
    heading: 'Overview', strong: 'Streamed', inline: 'inline code', nested: 'Nested item', ordered: 3,
    quote: 'A quoted note.', code, table: 'main.ts', link: 'https://example.test/docs',
    emphasis: true, strike: true, rule: true, unsafe: false,
  });
  const output = path.join(root, 'results/markdown-smoke');
  mkdirSync(output, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    const styles = await evaluate(`(() => {
      const d = document.querySelector(${JSON.stringify(selector)});
      const pre = d.querySelector('pre'), code = d.querySelector('pre code');
      return {
        font: getComputedStyle(code).fontFamily,
        whitespace: getComputedStyle(pre).whiteSpace,
        overflow: getComputedStyle(pre).overflowX,
        background: getComputedStyle(pre).backgroundColor,
        border: getComputedStyle(pre).borderTopWidth,
        pageOverflows: document.documentElement.scrollWidth > innerWidth,
        codeOverflows: pre.scrollWidth > pre.clientWidth,
      };
    })()`);
    assert.match(styles.font, /monospace/);
    assert.equal(styles.whitespace, 'pre');
    assert.equal(styles.overflow, 'auto');
    assert.notEqual(styles.background, 'rgba(0, 0, 0, 0)');
    assert.equal(styles.border, '1px');
    assert.equal(styles.pageOverflows, false, 'long code stays inside the sidebar');
    assert.equal(styles.codeOverflows, true, 'long code scrolls without losing indentation');
    await evaluate("document.querySelector('#messages').scrollTop = 0");
    writeFileSync(path.join(output, `${theme}.png`), (await win.webContents.capturePage()).toPNG());
  }

  const finalId = await startTurn();
  finishTurn(prefix + '## Final only\n\n**Complete** without deltas.');
  await until(() => evaluate(`document.querySelector('.turn[data-turn="${finalId}"] h2')?.textContent === 'Final only'`), 'final-only answer renders');
  const job = { jobId: 'markdown-job', turnId: finalId, approach: active.config.approach, intent: 'task', question: 'Background answer', estimateS: 60, state: 'running' };
  send({ type: 'job', job });
  await until(() => evaluate("!!document.querySelector('.job')"), 'background card appears');
  assert.equal(await evaluate("document.querySelector('.job details.detail').hidden"), true);
  send({ type: 'job', job: { ...job, state: 'done', spoken: 'Fixed.', detail: prefix + markdown } });
  await until(() => conversation?.find(e => e.id === 'job:markdown-job')?.detail === markdown, 'background answer preserves original Markdown');
  await evaluate("document.querySelector('.job-marker').click(); document.querySelector('.job details.detail > summary').click()");
  assert.equal(await evaluate("document.querySelector('.job .md h1')?.textContent"), 'Overview');
  assert.equal(await evaluate("document.querySelector('.job .md pre code')?.textContent"), code);
  assert.equal(await evaluate("document.querySelector('.job details.detail').open"), true);
  assert.deepEqual(errors, []);
  console.log('Markdown smoke passed: streaming, final-only answers, background jobs, original Markdown forwarding, safe text, themes and narrow-sidebar code overflow.');
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
