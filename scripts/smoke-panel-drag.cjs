// Real pointer input against the sandboxed page preload, including updates during a drag.
// Run: npm run build:electron && npx electron scripts/smoke-panel-drag.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const userData = mkdtempSync(path.join(tmpdir(), 'vizzo-panel-drag-'));
app.setPath('userData', userData);
let win, ready = false;
const errors = [], actions = [];
ipcMain.on('hotkeys:get', e => { e.returnValue = null; });
ipcMain.handle('drawing:get', () => false);
ipcMain.handle('comment:get', () => false);
ipcMain.handle('page:state', () => ({ tFrom: null }));
ipcMain.handle('page:history-state', () => ({ back: false, forward: false }));
ipcMain.on('page:ready', () => { ready = true; });
ipcMain.on('page:thread', (_e, action) => actions.push(action));
const cdp = (method, params = {}) => win.webContents.debugger.sendCommand(method, params);
const send = cmd => win.webContents.send('page:cmd', cmd);
async function until(fn, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    assert.deepEqual(errors, [], 'page must not throw');
    if (await fn()) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Timeout: ${label}`);
}
async function node(selector) {
  const { root } = await cdp('DOM.getDocument', { depth: -1, pierce: true });
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const shadow of current.shadowRoots ?? []) {
      const { nodeId } = await cdp('DOM.querySelector', { nodeId: shadow.nodeId, selector });
      if (nodeId) return nodeId;
    }
    pending.push(...(current.children ?? []), ...(current.shadowRoots ?? []));
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
const rect = selector => inspect(selector, 'function(){const r=this.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}}');
const mouse = (type, x, y, button = 'left') => cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1 });
async function press(selector) {
  const r = await rect(selector);
  const point = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  await mouse('mousePressed', point.x, point.y);
  return point;
}
async function click(selector) {
  const p = await press(selector);
  await mouse('mouseReleased', p.x, p.y);
}
async function drag(selector, dx, dy) {
  const p = await press(selector);
  await mouse('mouseMoved', p.x + dx, p.y + dy);
  await mouse('mouseReleased', p.x + dx, p.y + dy);
}
function moved(before, after, dx, dy) {
  assert(Math.abs(after.left - before.left - dx) < 1, 'panel follows horizontal pointer movement');
  assert(Math.abs(after.top - before.top - dy) < 1, 'panel follows vertical pointer movement');
}
async function inside(selector, margin) {
  const r = await rect(selector);
  const v = await win.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
  assert(r.left >= margin - 1 && r.top >= margin - 1, 'panel stays within top and left bounds');
  assert(r.left + r.width <= v.width - margin + 1 && r.top + r.height <= v.height - margin + 1, 'panel stays within bottom and right bounds');
}

async function main() {
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: {
    preload: path.resolve(__dirname, '../dist-electron/page-preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false,
  } });
  const deadline = setTimeout(() => { console.error('Panel drag smoke timed out.'); finish(1); }, 30000);
  await win.loadURL(`data:text/html,${encodeURIComponent('<style>body{margin:0;height:2000px}#target{position:absolute;left:450px;top:200px;width:100px;height:40px}</style><button id="target">Target</button><script>window.pageClicks=0;document.addEventListener("click",()=>pageClicks++)</script>')}`);
  win.webContents.debugger.attach('1.3');
  win.webContents.debugger.on('message', (_e, method, params) => {
    if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
  });
  await cdp('Runtime.enable');
  await until(() => ready, 'preload ready');

  win.webContents.send('page:comment-mode', true);
  win.webContents.send('page:comment-at', { x: 500, y: 220 });
  await until(() => node('.cm-bubble'), 'comment opens');
  const pin = await rect('.cm-pin');
  await inspect('.cm-bubble textarea', 'function(){this.value="Keep my draft";this.dispatchEvent(new Event("input",{bubbles:true}));this.focus();this.setSelectionRange(2,5)}');
  const before = await rect('.cm-bubble');
  await drag('.cm-title', 80, 70);
  const comment = await rect('.cm-bubble');
  moved(before, comment, 80, 70);
  assert.deepEqual(await rect('.cm-pin'), pin, 'dragging leaves the target pin in place');
  send({ type: 'comment.state', state: { instant: false, recording: false, transcribing: false, partial: '' } });
  await until(() => inspect('.cm-bubble .if-send', 'function(){return this.getAttribute("aria-label")==="Add to the list"}'), 'comment refresh');
  assert.deepEqual(await rect('.cm-bubble'), comment, 'form updates preserve the dragged position');
  assert.deepEqual(await inspect('.cm-bubble textarea', 'function(){return {text:this.value,start:this.selectionStart,end:this.selectionEnd,focused:this.getRootNode().activeElement===this}}'), { text: 'Keep my draft', start: 2, end: 5, focused: true }, 'drag preserves the draft, selection and focus');
  let p = await press('.cm-title');
  await mouse('mouseMoved', 1, 1);
  await mouse('mouseReleased', 1, 1);
  await inside('.cm-bubble', 10);
  assert.equal(await inspect('.cm-bubble', 'function(){return this.classList.contains("dragging")}'), false, 'release clears dragging state');
  await click('.cm-close');
  await until(async () => !(await node('.cm-bubble')), 'comment Close works');
  win.webContents.send('page:comment-mode', false);

  const thread = {
    threadId: 'drag-test', pageUrl: '', title: 'Target', state: 'idle', intent: 'task', summary: '', unread: false, awaitingReply: false, createdAt: 0, lastInteractionAt: 0,
    anchor: { pageUrl: '', selector: '#target', domPath: '#target', dataSource: null, label: 'Target', text: 'Target', role: null, tag: 'button', bounds: { x: 450, y: 200, width: 100, height: 40 } },
    messages: [{ id: 'm1', turnId: null, at: 0, role: 'assistant', kind: 'result', text: 'Earlier answer.' }],
  };
  send({ type: 'threads', threads: [thread] });
  win.webContents.send('page:open-thread', thread.threadId);
  await until(() => node('.th-panel'), 'thread opens');
  const start = await rect('.th-panel');
  p = await press('.th-title');
  await mouse('mouseMoved', p.x + 80, p.y + 40);
  thread.title = 'Updated target';
  thread.state = 'running';
  send({ type: 'threads', threads: [thread] });
  await until(() => inspect('.th-title', 'function(){return this.textContent.includes("Updated target")}'), 'header replaced during drag');
  await mouse('mouseMoved', p.x + 160, p.y + 80);
  await mouse('mouseReleased', p.x + 160, p.y + 80);
  const position = await rect('.th-panel');
  moved(start, position, 160, 80);
  assert.equal(await inspect('.th-panel', 'function(){return getComputedStyle(this,"::before").display}'), 'none', 'detached panel hides its marker tail');
  await click('.th-stop');
  await until(() => actions.some(action => action.type === 'thread.stop'), 'Stop works after dragging');
  assert.deepEqual(await rect('.th-panel'), position, 'header buttons do not drag');
  await click('.th-trash');
  await until(() => node('.th-confirm'), 'Delete opens its confirmation');
  await click('.th-foot button:not(.th-danger)');
  await drag('.th-resize-handle[data-corner="se"]', 50, 30);
  const resized = await rect('.th-panel');
  assert(resized.width > position.width, 'resizing still works after dragging');
  await drag('.th-title', -50, -30);
  moved(resized, await rect('.th-panel'), -50, -30);
  p = await press('.th-title');
  await mouse('mouseMoved', 1, 1);
  await mouse('mouseReleased', 1, 1);
  await inside('.th-panel', 8);
  win.setSize(420, 500);
  await until(async () => (await rect('.th-panel')).width <= 404, 'window resize clamps the panel');
  await inside('.th-panel', 8);
  await click('.th-close');
  await until(async () => !(await node('.th-panel')), 'thread Close works');

  win.setSize(1000, 760);
  await until(() => win.webContents.executeJavaScript('innerWidth===1000'), 'window expands');
  await click('.th-orb');
  await until(() => node('.th-panel.fixed'), 'conversation opens');
  const conversation = await rect('.th-panel');
  await drag('.th-title', -100, -80);
  moved(conversation, await rect('.th-panel'), -100, -80);
  const fixed = await rect('.th-panel');
  await win.webContents.executeJavaScript('window.scrollTo(0,100)');
  assert.deepEqual(await rect('.th-panel'), fixed, 'conversation stays fixed while scrolling');
  assert.equal(await win.webContents.executeJavaScript('window.pageClicks'), 0, 'overlay dragging and buttons do not click the page');
  assert.deepEqual(errors, []);
  clearTimeout(deadline);
  console.log('Panel drag smoke passed: comment, thread and conversation dragging; live header updates; draft focus; bounds; resize and header controls.');
}

main().then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) {
  win?.destroy();
  rmSync(userData, { recursive: true, force: true });
  app.exit(code);
}
