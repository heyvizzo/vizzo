// Real preload regression: offscreen drawing markers must never enlarge the page.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'vizzo-marker-smoke-')));
ipcMain.on('hotkeys:get', (e) => { e.returnValue = null; });
ipcMain.handle('drawing:get', () => false);
ipcMain.handle('comment:get', () => false);
ipcMain.handle('page:state', () => ({ tFrom: null }));
const pause = () => new Promise(resolve => setTimeout(resolve, 150));
async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1440, height: 800, show: false, webPreferences: {
    preload: path.resolve(__dirname, '../dist-electron/page-preload.cjs'), sandbox: true, contextIsolation: true,
  } });
  await win.loadURL('data:text/html,<style>body{margin:0;height:2000px}section{width:100%;height:300px}</style><section id="hero">Hero</section>');
  await pause();
  const anchor = { kind: 'drawing', pageUrl: '', selector: '', domPath: 'drawing:old', dataSource: null, label: null, text: null, role: null, tag: 'drawing', bounds: { x: 1100, y: 200, width: 200, height: 100 }, point: { x: 1200, y: 250 } };
  const thread = { threadId: 'drawing', pageUrl: '', anchor, title: 'the drawing', state: 'queued', intent: 'task', summary: '', unread: false, awaitingReply: false, messages: [], createdAt: 1, lastInteractionAt: 1 };
  win.webContents.send('page:cmd', { type: 'threads', threads: [thread] });
  win.webContents.send('page:cmd', { type: 'provisional', turnId: 'pending', anchor });
  for (const width of [1440, 360, 768, 320]) {
    win.setSize(width, 800);
    await pause();
    const sizes = await win.webContents.executeJavaScript('({page:document.documentElement.scrollWidth, viewport:document.documentElement.clientWidth})');
    assert.equal(sizes.page, sizes.viewport, `marker overflow at ${width}px`);
  }
  // Element-backed markers still track the document while scrolling.
  win.webContents.send('page:cmd', { type: 'threads', threads: [{ ...thread, anchor: { ...anchor, selector: '#hero', domPath: '#hero', bounds: { x: 0, y: 0, width: 1440, height: 300 }, point: { x: 720, y: 150 } } }] });
  await win.webContents.executeJavaScript('window.scrollTo(0,100)');
  await pause();
  win.webContents.debugger.attach('1.3');
  const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
  function find(node) {
    if (node.attributes?.some((v, i, a) => a[i - 1] === 'class' && v.split(' ').includes('th-marker'))) return node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) { const hit = find(child); if (hit) return hit; }
  }
  const marker = find(root);
  assert.ok(marker, 'marker remains present');
  const { model } = await win.webContents.debugger.sendCommand('DOM.getBoxModel', { nodeId: marker.nodeId });
  assert.ok(Math.abs((model.border[1] + model.border[5]) / 2 - 50) < 1, 'marker follows document scroll');
  console.log('Passed: desktop-to-phone resize, provisional markers, and anchored marker scrolling.');
}
main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
