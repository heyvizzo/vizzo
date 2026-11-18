// Run after npm run build:electron with: npx electron scripts/smoke-changes-electron.cjs
// Exercise the real Electron main, shell and page preloads with a disposable voice server and Changes document.
const { app, BrowserWindow, dialog, ipcMain, session, utilityProcess, webContents } = require("electron");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const nodeModule = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { WebSocketServer } = require("ws");

// Vite's optional fsevents watcher can deadlock at Electron teardown. Use its built-in fallback in this test.
const { _load } = nodeModule;
nodeModule._load = function (id, ...args) {
  if (id === "fsevents") throw Object.assign(new Error("fsevents is disabled for this fixture"), { code: "MODULE_NOT_FOUND" });
  return _load.call(this, id, ...args);
};

const root = path.resolve(__dirname, "..");
const fixture = mkdtempSync(path.join(os.tmpdir(), "vizzo-changes-electron-"));
const userData = path.join(fixture, "app");
const first = path.join(fixture, "first");
const second = path.join(fixture, "second");
const outside = path.join(fixture, "outside");
for (const dir of [userData, first, second, outside]) mkdirSync(dir);
const settings = path.join(userData, "settings.json");
const pageFile = path.join(fixture, "page.html");
const pageUrl = pathToFileURL(pageFile).href;
writeFileSync(pageFile, '<button id="target" style="position:absolute;left:350px;top:250px">Target</button>');
writeFileSync(settings, JSON.stringify({ projectDir: first, lastUrl: pageUrl }));
app.setPath("userData", userData);
app.setPath("appData", fixture);
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");

const threadId = "thread with / & spaces";
const thread = {
  threadId, pageUrl, title: "Target", state: "idle", intent: "task",
  summary: "", unread: false, awaitingReply: false, createdAt: 0, lastInteractionAt: 0, messages: [],
  anchor: {
    pageUrl, selector: "#target", domPath: "body > #target", dataSource: null,
    label: "Target", text: "Target", role: null, tag: "button", bounds: { x: 350, y: 250, width: 70, height: 30 },
  },
};
const ready = { kind: "ready", project: "first", generation: 1, changedFiles: 3, ownedThreadIds: [threadId] };
const oldGit = { kind: "unavailable", reason: "Source control requires Git 2.41 or later" };
const lifecycle = [];
let selected = second;
let changesRequest = 0;
let utility;
let backend;
let sockets;
const publish = (status, request = changesRequest) => utility.emit("message", { type: "changes-status", status, changesRequest: request });
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
utilityProcess.fork = (_module, _args, options) => {
  utility = new EventEmitter();
  utility.postMessage = (message) => {
    switch (message.type) {
      case "flush": utility.emit("message", { type: "flushed" }); break;
      case "changes-visible":
      case "changes-focus": lifecycle.push(message); break;
      case "project":
        changesRequest = message.changesRequest;
        publish(message.dir === second
          ? { kind: "ready", project: "second", generation: 2, changedFiles: 1, ownedThreadIds: [] }
          : { kind: "non-repository", reason: "The project folder is not in a Git worktree" });
        break;
    }
  };
  utility.kill = () => backend.close();
  backend = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const body = req.url === "/api/llm/notice" ? null
      : req.url === "/api/llm/providers" ? []
      : req.url === "/api/speech/engines" ? { engines: [] }
      : {};
    res.end(JSON.stringify(body));
  });
  sockets = new WebSocketServer({ server: backend, path: "/ws" });
  sockets.on("connection", (peer) => {
    peer.send(JSON.stringify({ type: "threads.snapshot", threads: [thread] }));
    peer.on("message", (data, binary) => {
      if (binary) return;
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping") peer.send(JSON.stringify({ ...msg, type: "pong", serverNow: performance.now() }));
    });
  });
  backend.listen(Number(options.env.PORT), "127.0.0.1", () => {
    utility.emit("message", { type: "ready" });
    publish(ready);
  });
  return utility;
};

// Main migrates preferences from the old dev home at startup. Keep that lookup inside the fixture too.
const originalHome = os.homedir;
os.homedir = () => fixture;
try { require(path.join(root, "dist-electron", "main.cjs")); }
finally { os.homedir = originalHome; }

const changesWindows = () => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes("/changes.html"));
const byUrl = (suffix) => webContents.getAllWebContents().find((wc) => wc.getURL().endsWith(suffix));
const visible = () => lifecycle.filter((m) => m.type === "changes-visible").map((m) => m.visible);
const focusCount = () => lifecycle.filter((m) => m.type === "changes-focus").length;
async function until(check, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      if (!/Could not find node with given id|No node with given id found/.test(String(error))) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timeout: ${label}`);
}

async function panelNode(page, selector) {
  const cdp = (method, params) => page.debugger.sendCommand(method, params);
  const { root } = await cdp("DOM.getDocument", { depth: -1, pierce: true });
  const queue = [root];
  for (const node of queue) {
    queue.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
    if (node.shadowRootType !== "closed") continue;
    const { nodeId } = await cdp("DOM.querySelector", { nodeId: node.nodeId, selector });
    if (nodeId) return nodeId;
  }
  return 0;
}

async function inspect(page, selector, functionDeclaration) {
  const nodeId = await panelNode(page, selector);
  if (!nodeId) return null;
  const { object } = await page.debugger.sendCommand("DOM.resolveNode", { nodeId });
  const result = await page.debugger.sendCommand("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration, returnByValue: true });
  assert(!result.exceptionDetails, result.exceptionDetails?.text);
  return result.result.value;
}

async function clickCommit(page, button) {
  const cdp = (method, params) => page.debugger.sendCommand(method, params);
  const { model: { content } } = await cdp("DOM.getBoxModel", { nodeId: button });
  const x = (content[0] + content[4]) / 2;
  const y = (content[1] + content[5]) / 2;
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function run() {
  await app.whenReady();
  session.fromPartition("changes").protocol.handle("http", () => new Response(
    '<title>Changes fixture</title><script>window.scopeResets=0; addEventListener("hashchange", () => scopeResets++)</script>',
    { headers: { "Content-Type": "text/html" } },
  ));
  const toolbar = await until(() => byUrl("/shell/index.html"), "toolbar");
  const sidebar = await until(() => byUrl("/chat.html"), "sidebar");
  const page = await until(() => byUrl("/page.html"), "browser pane");
  const bar = (code) => toolbar.executeJavaScript(code);
  const commitButton = () => panelNode(page, ".th-panel .th-commit");
  const commitDisabled = () => inspect(page, ".th-panel .th-commit", "function() { return this.disabled; }");
  await until(() => bar('document.querySelector("#changes-count").textContent === "3"'), "current project's distinct file count");
  await sidebar.executeJavaScript("shell.queue.publish({ instant: true, count: 2, sending: false })");
  await until(() => bar('document.querySelector("#queue-count").textContent === "2"'), "separate queue count");
  assert(await bar(`(() => {
    const b = document.querySelector("#changes");
    return b.previousElementSibling.id === "instant" && b.nextElementSibling.id === "send-queue"
      && !b.nextElementSibling.hidden && b.previousElementSibling.getAttribute("aria-pressed") === "true";
  })()`));

  assert.equal(await sidebar.executeJavaScript("shell.changes.getStatus()"), null, "toolbar status is guarded");
  await sidebar.executeJavaScript("shell.changes.open()");
  assert.equal(changesWindows().length, 0, "the sidebar cannot impersonate the toolbar");
  assert.equal(await page.executeJavaScript("typeof window.shell"), "undefined", "the visited page has no Changes bridge");
  ipcMain.emit("page:thread", { sender: sidebar, senderFrame: sidebar.mainFrame }, { type: "thread.commit", threadId });
  ipcMain.emit("page:thread", { sender: page, senderFrame: null }, { type: "thread.commit", threadId });
  ipcMain.emit("page:thread", { sender: page, senderFrame: page.mainFrame }, { type: "thread.commit", threadId: "unowned" });
  assert.equal(BrowserWindow.getAllWindows().length, 1, "invalid thread opens are ignored");

  await bar('document.querySelector("#changes").click()');
  const window = await until(() => changesWindows().find((w) => w.isVisible()), "unscoped Changes window");
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  assert.equal(await evaluate("location.hash"), "");
  assert.equal(await evaluate("typeof window.shell"), "undefined", "Changes has no shell credentials or IPC");
  assert.equal(await evaluate("window.open('/untrusted')"), null, "Changes cannot create a popup");
  await until(() => focusCount() > 0, "scanner focus");
  await until(() => visible().at(-1) === true, "scanner visibility");
  assert.deepEqual(visible(), [true]);

  page.debugger.attach("1.3");
  await until(() => sidebar.executeJavaScript('document.querySelectorAll(".thread-item").length === 1'), "thread snapshot");
  page.send("page:open-thread", threadId);
  await until(commitButton, "owned thread's Commit button");
  assert.equal(await commitDisabled(), false);
  const button = await commitButton();
  const { object } = await page.debugger.sendCommand("DOM.resolveNode", { nodeId: button });
  await page.debugger.sendCommand("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function() { this.click(); }" });
  assert.equal(await evaluate("location.hash"), "", "synthetic overlay clicks do not open Changes");
  await clickCommit(page, button);
  const hash = `#thread=${encodeURIComponent(threadId)}`;
  await until(async () => await evaluate("location.hash") === hash, "encoded thread scope");
  const resets = await evaluate("scopeResets");
  await clickCommit(page, await commitButton());
  await until(async () => await evaluate("scopeResets") === resets + 1, "same scope resets");
  await bar('document.querySelector("#changes").click()');
  await until(async () => await evaluate("location.hash") === "", "toolbar clears scope");
  assert.deepEqual(changesWindows().map((w) => w.id), [window.id]);

  await clickCommit(page, await commitButton());
  await until(async () => await evaluate("location.hash") === hash, "scope opens again");
  await inspect(page, ".th-panel textarea", `function() {
    this.value = "A draft";
    this.dispatchEvent(new Event("input", { bubbles: true }));
    this.focus();
    this.setSelectionRange(2, 5);
  }`);
  await bar("shell.pickProject()");
  publish({ ...ready, changedFiles: 99 }, 0);
  await until(() => bar('document.querySelector("#changes-count").textContent === "1"'), "project switch replaces status");
  await until(async () => await evaluate("location.hash") === "" && await commitDisabled(), "old project's scope clears and its Commit becomes disabled");
  assert.deepEqual(await inspect(page, ".th-panel textarea", `function() {
    return { text: this.value, start: this.selectionStart, end: this.selectionEnd, focused: this.getRootNode().activeElement === this };
  }`), { text: "A draft", start: 2, end: 5, focused: true });
  assert(window.isVisible());

  window.minimize();
  await until(() => visible().at(-1) === false, "minimize stops the scan timer");
  await bar('document.querySelector("#changes").click()');
  await until(() => visible().at(-1) === true && !window.isMinimized(), "reopen restores the same window");
  window.hide();
  await until(() => visible().at(-1) === false, "hide stops the scan timer");
  window.show();
  await until(() => visible().at(-1) === true, "show starts the scan timer");
  window.setSize(650, 470);
  window.center();
  const bounds = window.getNormalBounds();
  window.close();
  await until(() => visible().at(-1) === false && !changesWindows().length, "close clears visibility");
  assert.deepEqual(JSON.parse(readFileSync(settings)).changesBounds, bounds);
  await bar('document.querySelector("#changes").click()');
  const reopened = await until(() => changesWindows().find((w) => w.isVisible()), "reopened Changes window");
  assert.deepEqual(reopened.getNormalBounds(), bounds);
  reopened.close();

  selected = outside;
  await bar("shell.pickProject()");
  await until(() => bar('document.querySelector("#changes").hidden'), "no repository hides Changes");
  await until(async () => !(await commitButton()), "no repository hides thread Commit");
  publish(oldGit);
  await until(() => bar('!document.querySelector("#changes").hidden'), "outdated Git shows the unavailable button");
  assert.match(await bar('document.querySelector("#changes").getAttribute("aria-label")'), /requires Git 2\.41 or later/);
  await until(commitDisabled, "outdated Git disables thread Commit");
  assert.match(await inspect(page, ".th-panel .th-commit", 'function() { return this.getAttribute("aria-label"); }'), /requires Git 2\.41 or later/);
  console.log("Changes Electron smoke passed: toolbar ordering, counts and Git availability, trusted IPC, thread scope, project switches, scanner lifecycle, and restored bounds.");
}

async function finish(code) {
  for (const contents of webContents.getAllWebContents()) contents.close({ waitForBeforeUnload: false });
  for (const win of BrowserWindow.getAllWindows()) win.destroy();
  for (const peer of sockets?.clients ?? []) peer.terminate();
  sockets?.close();
  backend?.close();
  rmSync(fixture, { recursive: true, force: true });
  app.exit(code);
}
run().then(() => finish(0), (error) => { console.error(error); return finish(1); });
