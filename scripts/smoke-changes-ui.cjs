// Exercise the built Changes renderer in a disposable Electron window with local HTTP and WebSocket fixtures.
const { app, BrowserWindow, nativeTheme } = require('electron');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const dist = path.resolve(__dirname, '../dist');
const userData = mkdtempSync(path.join(tmpdir(), 'vizzo-changes-ui-'));
app.setPath('userData', userData);
const project = 'project&one';
const thread = { kind: 'thread', id: 'header + /' };
const job = { kind: 'job', id: 'footer' };
const central = { kind: 'central', id: 'central' };
const commit = '0123456789abcdef0123456789abcdef01234567';
const file = (id, writers, other, path, extra = {}) => ({
  id, writers, other, selectable: true, files: [{ path, entry: 'text', added: 2, removed: 1 }], ...extra,
});
const components = [
  file('own', [thread], false, 'src/header.ts'),
  file('tied', [thread, job], false, 'src/shared # footer.ts', { tieReason: 'Shared by more than one writer' }),
  file('mixed', [thread], true, 'src/mixed.ts', { tieReason: 'Also has Other changes' }),
  file('working', [central], false, 'src/running.ts', { selectable: false, reason: 'Still working…' }),
  file('other', [], true, 'src/user.ts'),
  file('job-own', [job], false, 'src/footer.ts'),
];
const groups = [
  { writer: job, title: 'Finish the footer', state: 'open', own: ['job-own'], tied: ['tied'] },
  { writer: central, title: 'Update the page', state: 'working', own: ['working'], tied: [] },
  { writer: thread, title: 'Fix the header', state: 'open', incomplete: true, own: ['own'], tied: ['tied', 'mixed'] },
];
let view = { generation: 1, branch: 'refs/heads/feature/header', base: null, groups, components, changedFiles: components.length, notices: [] };
let status;
let jobs = { jobs: [{ id: 'fix-me', commit, reason: 'Git’s staging area needs repair.', canFix: true }], restart: ['codex'] };
let win, firstDraft, finishFix, finishCombined;
const errors = [];
const calls = [];
const socket = new WebSocketServer({ noServer: true });
const server = createServer((req, res) => { void serve(req, res).catch(error => { errors.push(String(error)); res.destroy(); }); });
server.on('upgrade', (req, transport, head) => {
  if (req.url === '/ws?view=changes') socket.handleUpgrade(req, transport, head, client => socket.emit('connection', client));
  else transport.destroy();
});

function broadcast(message) {
  for (const client of socket.clients) client.send(JSON.stringify(message));
}

async function serve(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  if (!pathname.startsWith('/api/')) {
    const ext = path.extname(pathname);
    const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' }[ext];
    if (type && /^\/(changes\.html|favicon\.png|assets\/[A-Za-z0-9_.-]+)$/.test(pathname)) {
      res.writeHead(200, { 'Content-Type': type });
      return res.end(readFileSync(path.join(dist, pathname.slice(1))));
    }
    res.writeHead(404);
    return res.end();
  }
  let body;
  if (req.method === 'POST') {
    assert.equal(req.headers['content-type'], 'application/json');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
  }
  calls.push({ path: pathname, query: Object.fromEntries(url.searchParams), body });
  const respond = (data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  switch (pathname) {
    case '/api/changes/status':
      return respond(status ?? { kind: 'ready', project, generation: view.generation, changedFiles: view.changedFiles, ownedThreadIds: [thread.id] });
    case '/api/changes':
      assert.equal(url.searchParams.get('project'), project);
      return respond(view);
    case '/api/changes/diff':
      assert.equal(url.searchParams.get('project'), project);
      assert.equal(Number(url.searchParams.get('generation')), view.generation);
      return respond({ generation: view.generation, component: url.searchParams.get('component'), path: url.searchParams.get('path'), hunks: [{
        kind: 'content', range: { oldStart: 2, oldCount: 1, newStart: 2, newCount: 2 },
        before: 'old();\n', after: 'header();\nfooter();\n', writers: [thread, job], other: false,
      }] });
    case '/api/changes/jobs':
      assert.equal(url.searchParams.get('project'), project);
      return respond(jobs);
    case '/api/changes/message':
      if (!firstDraft) { firstDraft = () => respond({ message: 'Outdated prefill' }); return; }
      return respond({ message: 'Update project files' });
    case '/api/changes/commit':
      if (!body.separately) {
        finishCombined = () => {
          const remaining = view.components.filter(item => !body.components.includes(item.id));
          view = {
            ...view, generation: view.generation + 1, components: remaining, changedFiles: remaining.length,
            groups: view.groups.filter(group => [...group.own, ...group.tied].some(id => remaining.some(item => item.id === id))),
          };
          respond({ commits: [commit] });
        };
        return;
      }
      if (body.components.length === 1 && body.components[0] === 'other-new') {
        view = { ...view, generation: 4, components: view.components.map(item =>
          item.id === 'other-new' ? file('other-later', [], true, 'src/later.ts') : item) };
        return respond({ commits: [commit] });
      }
      view = { ...view, generation: 3, notices: ['HEAD moved: some changes are now marked Other'] };
      return respond({ commits: [commit], reason: 'Changed meanwhile: review again' }, 409);
    case '/api/changes/fix':
      finishFix = () => {
        jobs = { ...jobs, jobs: [] };
        respond({ ok: true });
      };
      return;
    case '/api/changes/restart':
      jobs = { ...jobs, restart: [] };
      return respond({ ok: true });
    default:
      return respond({ reason: `Unexpected ${pathname}` }, 404);
  }
}

async function evaluate(source) {
  try { return await win.webContents.executeJavaScript(source); }
  catch (error) { throw new Error(`Couldn’t evaluate ${source}`, { cause: error }); }
}
async function waitFor(condition, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    assert.deepEqual(errors, [], 'Changes must run without renderer or fixture exceptions');
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 35));
  }
  assert.fail(description);
}
const waitForDom = (source, description) => waitFor(() => evaluate(source), description);
const checked = id => evaluate(`[...document.querySelectorAll('input[data-component="${id}"]')].map(tick => tick.checked)`);
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const lastCall = route => calls.findLast(call => call.path === `/api/changes/${route}`);

async function key(selector, value, code, virtualCode) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  const fields = { key: value, code, windowsVirtualKeyCode: virtualCode };
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...fields });
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...fields });
}

async function main() {
  server.listen(0, '127.0.0.1');
  await Promise.all([app.whenReady(), once(server, 'listening')]);
  nativeTheme.themeSource = 'light';
  win = new BrowserWindow({ show: false, width: 760, height: 650, webPreferences: { backgroundThrottling: false } });
  win.webContents.debugger.attach('1.3');
  win.webContents.debugger.on('message', (_event, method, params) => {
    if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
  });
  // The renderer target becomes ready during navigation.
  void win.webContents.debugger.sendCommand('Runtime.enable').catch(error => errors.push(String(error)));
  const scope = `#thread=${encodeURIComponent(thread.id)}`;
  await win.loadURL(`http://127.0.0.1:${server.address().port}/changes.html${scope}`);
  await waitForDom('document.querySelector("#groups h2")?.textContent === "Fix the header"', 'Scoped thread appears first');
  assert.equal(await evaluate('document.querySelector("#branch-name").textContent'), 'feature/header');
  assert.match(await evaluate('document.querySelector("#branch-state").textContent'), /No commits yet/);
  assert.equal(await evaluate('document.querySelector("#file-count").textContent'), '6 changed files');
  assert.equal(await evaluate('document.querySelector(".other-threads").open'), false);
  assert.equal(await evaluate('document.querySelector(".other-threads summary").textContent'), 'Other threads (2)');
  assert.equal(await evaluate('document.querySelector("#groups > :last-child h2").textContent'), 'Other changes');
  assert.match(await evaluate('document.querySelector("#groups").textContent'), /Incomplete work/);
  assert.match(await evaluate('document.querySelector("#commit-form").textContent'), /Pre-commit and commit-msg hooks don’t run\./);
  assert.deepEqual(await checked('own'), [true]);
  assert.deepEqual(await checked('tied'), [false, false]);
  assert.deepEqual(await checked('mixed'), [false]);
  assert.deepEqual(await checked('other'), [false]);
  assert.equal(await evaluate('document.querySelector("#select-all").labels[0].textContent.trim()'), 'Select all changes');
  assert.match(await evaluate('document.getElementById(document.querySelector("#select-all").getAttribute("aria-describedby")).textContent'), /Includes Other changes/);
  assert.equal(await evaluate('document.querySelector("#select-all").indeterminate'), true);
  assert.equal(await evaluate('document.querySelector("input[data-component=working]").disabled'), true);
  assert.match(await evaluate('document.querySelector("input[data-component=mixed]").parentElement.textContent'), /Needs your call/);

  await waitFor(() => !!firstDraft, 'Scoped selection requests a prefill');
  await evaluate('const input = document.querySelector("#commit-message"); input.value = "Edit the header by hand"; input.dispatchEvent(new Event("input"));');
  firstDraft();
  await key('input[data-component=tied]', ' ', 'Space', 32);
  assert.deepEqual(await checked('tied'), [true, true], 'Keyboard tick updates both tied rows');
  await key('.component:has(input[data-component=tied]) summary', ' ', 'Space', 32);
  await waitForDom('document.querySelector(".hunk-head")?.textContent.includes("Finish the footer")', 'Keyboard opens diff and renders owners');
  assert.match(await evaluate('document.querySelector(".hunk").textContent'), /@@ -3,1 \+3,2 @@.*Fix the header, Finish the footer/s);
  assert.equal(lastCall('diff').query.path, 'src/shared # footer.ts');
  assert.equal(await evaluate('document.querySelector("#commit-message").value'), 'Edit the header by hand');
  await click('input[data-component=other]');

  view = { ...view, generation: 2, components: components.map(item =>
    item.id === 'other' ? file('other-new', [], true, 'src/user.ts') : item) };
  broadcast({ type: 'changes.updated', project, generation: 2 });
  await waitForDom('!!document.querySelector("input[data-component=other-new]")', 'WebSocket refreshes changes');
  assert.deepEqual(await checked('other-new'), [false], 'Changed Other never inherits an earlier tick');
  assert.deepEqual(await checked('tied'), [true, true]);
  assert.deepEqual(await checked('own'), [true]);

  if (process.env.CHANGES_UI_SCREENSHOT) {
    writeFileSync(`${process.env.CHANGES_UI_SCREENSHOT}.light.png`, (await win.webContents.capturePage({ stayHidden: true })).toPNG());
    nativeTheme.themeSource = 'dark';
    await waitForDom('matchMedia("(prefers-color-scheme: dark)").matches', 'Dark theme follows the system theme');
    writeFileSync(`${process.env.CHANGES_UI_SCREENSHOT}.dark.png`, (await win.webContents.capturePage({ stayHidden: true })).toPNG());
  }

  await click('#commit-separately');
  await waitForDom('document.querySelector("#notices").textContent.includes("HEAD moved")', 'Conflict refreshes the review');
  assert.equal(lastCall('commit').body.project, project);
  assert.equal(lastCall('commit').body.generation, 2);
  assert.deepEqual(lastCall('commit').body.components, ['own', 'tied']);
  assert.equal(lastCall('commit').body.message, 'Edit the header by hand');
  assert.equal(lastCall('commit').body.separately, true);
  assert.equal(lastCall('commit').body.scopeThreadId, thread.id);
  assert.match(await evaluate('document.querySelector("#result").textContent'), new RegExp(`${commit}.*Changed meanwhile: review again`, 's'));
  assert.equal(await evaluate('document.querySelectorAll("input[data-component]:checked").length'), 0);
  assert.equal(await evaluate('document.querySelector("#commit-message").value'), 'Edit the header by hand');
  assert.equal(await evaluate('document.querySelector("#commit").disabled'), true);

  await click('button[aria-label^="Fix staging"]');
  await waitFor(() => !!finishFix, 'Fix sends an explicit request');
  assert.equal(await evaluate('document.querySelector("#select-all").disabled'), true, 'Bulk selection stays disabled during Fix');
  finishFix();
  await waitForDom(`document.querySelector('#result').textContent.includes('staging area was updated') && !document.querySelector('button[aria-label^="Fix staging"]')`, 'Fix updates the pinned job');
  assert.deepEqual(lastCall('fix').body, { project, jobId: 'fix-me' });
  await click('.job button');
  await waitForDom('document.querySelector("#result").textContent.includes("Codex restarted") && !document.querySelector(".job button")', 'Restart refreshes harness status');
  assert.deepEqual(lastCall('restart').body, { project, generation: 3, harness: 'codex' });

  await evaluate('dispatchEvent(new HashChangeEvent("hashchange"))');
  await waitForDom('document.querySelector("input[data-component=own]").checked', 'Reopening the same scope resets the selection');
  await waitForDom('document.querySelector("#commit-message").value === "Update project files"', 'A fresh scope gets a new prefill');
  await evaluate('location.hash = ""');
  await waitForDom('!document.querySelector(".other-threads") && !document.querySelector("input:checked")', 'Opening unscoped clears the selection');
  await click('input[data-component=other-new]');
  await waitForDom('!document.querySelector("#commit-separately").disabled', 'An explicit Other-only selection can be committed separately');
  await click('#commit-separately');
  await waitForDom('document.querySelector("#result").textContent.startsWith("Committed ") && !document.querySelector("input[data-component=other-new]")', 'Other-only commit succeeds');
  assert.deepEqual(lastCall('commit').body, { project, generation: 3, components: ['other-new'], message: 'Update project files', separately: true });

  await evaluate(`location.hash = ${JSON.stringify(scope)}`);
  await waitForDom('document.querySelector(".other-threads") && document.querySelector("#select-all").indeterminate', 'Scoped review selects only its own work by default');
  const priorCommits = calls.filter(call => call.path === '/api/changes/commit').length;
  await key('#select-all', ' ', 'Space', 32);
  assert.equal(await evaluate('document.querySelector("#select-all").checked'), true);
  assert.equal(await evaluate('document.querySelector("#select-all").indeterminate'), false);
  assert.equal(await evaluate('document.querySelector(".other-threads").open'), false);
  assert.deepEqual(await checked('job-own'), [true], 'Bulk selection includes the collapsed writer’s own work');
  assert.deepEqual(await checked('tied'), [true, true], 'Bulk selection checks both displays of a shared component');
  assert.deepEqual(await checked('mixed'), [true]);
  assert.deepEqual(await checked('other-later'), [true]);
  assert.deepEqual(await checked('working'), [false], 'Bulk selection skips work in progress');

  await key('#select-all', ' ', 'Space', 32);
  assert.equal(await evaluate('document.querySelectorAll("input:checked").length'), 0, 'The checked bulk control clears every tick');
  assert.equal(await evaluate('document.querySelector("#select-all").indeterminate'), false);
  await key('#select-all', ' ', 'Space', 32);
  await waitForDom('!document.querySelector("#commit").disabled', 'Bulk selection gets a commit message');
  assert.equal(calls.filter(call => call.path === '/api/changes/commit').length, priorCommits, 'Selecting all never commits by itself');

  await click('#commit');
  await waitFor(() => !!finishCombined, 'Commit submits the bulk selection');
  assert.equal(await evaluate('document.querySelector("#select-all").disabled'), true, 'Bulk selection stays disabled during Commit');
  assert.deepEqual(lastCall('commit').body, {
    project, generation: 4, components: ['job-own', 'mixed', 'other-later', 'own', 'tied'],
    message: 'Update project files', separately: false, scopeThreadId: thread.id,
  });
  finishCombined();
  await waitForDom('document.querySelector("#result").textContent.startsWith("Committed ") && !document.querySelector("input[data-component=other-later]")', 'Bulk commit succeeds');
  assert.equal(calls.filter(call => call.path === '/api/changes/commit').length, priorCommits + 1);
  assert.equal(await evaluate('document.querySelector("#select-all").disabled'), true, 'Bulk selection disables when no changes are eligible');

  status = { kind: 'unavailable', reason: 'Git 2.41 or later is required.', project };
  broadcast({ type: 'changes.status', status });
  await waitForDom('document.querySelector("#availability").textContent.includes("Git 2.41") && document.querySelector("#commit-form").hidden && document.querySelector("#selection-controls").hidden', 'Unavailable project shows the reason and hides actions');
  status = undefined;
  view = { ...view, generation: 6, branch: null, base: commit, components: view.components.map(item => ({ ...item, selectable: false, reason: 'HEAD is detached' })) };
  broadcast({ type: 'changes.updated', project, generation: 6 });
  await waitForDom('document.querySelector("#branch-name").textContent === "Detached HEAD" && !document.querySelector("#branch").hidden', 'Detached HEAD is shown');
  assert.match(await evaluate('document.querySelector("#notices").textContent'), /Check out a branch to commit/);
  assert.equal(await evaluate('document.querySelector("#commit").disabled'), true);
  view = { ...view, generation: 7, branch: 'refs/heads/feature/header', components: [], groups: [], changedFiles: 0 };
  broadcast({ type: 'changes.updated', project, generation: 7 });
  await waitForDom('document.querySelector("#availability").textContent === "No changes to review." && document.querySelector("#selection-controls").hidden', 'Empty review hides bulk selection');
  assert.deepEqual(errors, []);
  console.log('Changes UI smoke passed: scoped selection and reset, keyboard ticks and diffs, bulk selection and one combined commit, Other review, message races, partial conflicts, hooks, Fix and Restart, unavailable status, and Git branch states.');
}

async function finish(code) {
  win?.destroy();
  for (const client of socket.clients) client.terminate();
  socket.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  rmSync(userData, { recursive: true, force: true });
  app.exit(code);
}

const deadline = setTimeout(() => { console.error('Changes UI smoke timed out.'); void finish(1); }, 25_000);
main().then(() => finish(0), error => { console.error(error); return finish(1); }).finally(() => clearTimeout(deadline));
