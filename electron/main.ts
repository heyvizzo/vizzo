// Electron app: a browser pane on the left (address bar + the page) and the voice chat as a sidebar on the right.
// The chat UI is served by Vite inside the app (chat.html) — there is no standalone website; the packaged app serves
// the built pages instead (webServer.ts). The voice server runs in a utilityProcess on a free local port and Vite
// (or webServer.ts) proxies /api and /ws to it. The server starts at launch, before a project folder is chosen (its
// agents wait in an empty temp folder until then), and it gets the browser pane's URL with every page change (it goes
// into each turn's context).
import {
  app, BrowserWindow, Menu, Notification, Tray, WebContentsView, clipboard, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, screen, shell,
  systemPreferences, utilityProcess,
  type IpcMainEvent, type IpcMainInvokeEvent, type UtilityProcess, type WebContents,
} from "electron";
import type { ViteDevServer } from "vite";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { CookieReadError, chromeSafeStoragePassword, readBrowserCookies, toElectronCookie, type BrowserId, type ElectronCookie } from "./cookies.ts";
import { applyEnv, ENV_FIELDS, readChangesPreferences, SECRET_KEYS, sanitizeEnv } from "./settings.ts";
import { editInstructions, instructionSnapshot } from "./instructions.ts";
import type { StoredInstructions } from "../shared/instructions.ts";
import { keychainService, openEnv, sealEnv, type Cipher } from "./secrets.ts";
import { bundlePath, readBundleId, tildify, uninstallPaths } from "./uninstall.ts";
import { startWebServer } from "./webServer.ts";
import { installThreadPanel } from "./threadPanel.ts";
import type { PageCmd } from "../web/cursor/pageBridge.ts";
import { installPageReload } from "./pageReload.ts";
import { LEGACY_NAMES, legacySecrets, moveLegacyDir } from "./rename.ts";
import { loginShellPath, mergePath } from "./shellPath.ts";
import { chromeKeychainAccess, fullDiskAccess, fullDiskRow, keychainRow, microphoneRow, type PermissionRow } from "./permissions.ts";
import { THEME } from "../shared/theme.ts";
import { continueSession, prepareSessionResume } from "../shared/sessionResume.ts";
import { endsHold, fromElectronInput, hotkeys, matchesDown, onHotkeys, setHotkeys } from "../shared/hotkeys.ts";
import type { ChangesStatus } from "../shared/changes.ts";
import { changesPreferences } from "../shared/changesPreferences.ts";
import { isPageThreadAction, type PageChangesStatus } from "../web/cursor/pageBridge.ts";
import { isSection } from "../web/settings/attention.ts";

const TOOLBAR_HEIGHT = 44;
const SIDEBAR_WIDTH = 480;
/** Limits for dragging the divider: the sidebar and the browser pane each keep at least this much. */
const MIN_SIDEBAR_WIDTH = 320;
const MIN_PANE_WIDTH = 360;
/** The divider's grab area, centered on the border between the browser pane and the sidebar. */
const DIVIDER_WIDTH = 7;
/** The top-right bar's width while the sidebar is hidden: just the button that shows the sidebar again. */
const COLLAPSED_BAR_WIDTH = 56;
const HOME_PAGE = "https://heyvizzo.com/";
const ROOT = join(__dirname, "..");
const TOOLBAR_FILE = join(__dirname, "shell", "index.html");
const TOOLBAR_URL = pathToFileURL(TOOLBAR_FILE).href;
const APP_NAME = "Vizzo";
// Electron names the settings folder after package.json's name, which `npm run dev` uses too: the packaged app keeps
// its own (~/Library/Application Support/Vizzo), so the two never share settings and its Uninstall
// only deletes its own. Set before anything reads userData.
// Its name too: safeStorage names the Keychain entry that encrypts the API keys after it ("<name> Safe Storage"),
// so the packaged app's (and its Uninstall's) is its own, not the dev app's.
if (app.isPackaged) {
  app.setName(APP_NAME);
  app.setPath("userData", join(app.getPath("appData"), APP_NAME));
}
/** What this app was called before it was Vizzo (electron/rename.ts): its settings folder and Keychain entry move over. */
const LEGACY_NAME = app.isPackaged ? LEGACY_NAMES.packaged : LEGACY_NAMES.dev;
moveLegacyDir(join(app.getPath("appData"), LEGACY_NAME), app.getPath("userData"));
if (!app.isPackaged) moveLegacyDir(join(homedir(), ".config", LEGACY_NAMES.config), join(homedir(), ".config", "vizzo"));
/**
 * The files child processes run (scripts/, tools/, dist-native/) and the server reads (server/prompts/). Packaged,
 * they're unpacked next to the asar (package.json build.asarUnpack): bash, Python and the Swift helpers can't read in it.
 */
const FILES_ROOT = app.isPackaged ? ROOT.replace(/app\.asar$/, "app.asar.unpacked") : ROOT;
/** Where the on-device speech models and their Python envs go: Application Support when packaged, the repo in dev. */
const SPEECH_DIR = process.env.SPEECH_DATA_DIR ?? (app.isPackaged ? join(app.getPath("userData"), "speech") : ROOT);

let win: BrowserWindow | null = null;
let toolbar: WebContentsView | null = null;
let folderBar: WebContentsView | null = null;
let browser: WebContentsView | null = null;
let sidebar: WebContentsView | null = null;
let threadPanel: ReturnType<typeof installThreadPanel> | null = null;
let divider: WebContentsView | null = null;
/** Draws hover tooltips over every other view (electron/tooltip.ts, shell/tooltip.html). */
let tooltip: WebContentsView | null = null;
/** The tooltip being laid out: its id and where its element is, in window coordinates. */
let tooltipPending: { id: number; x: number; y: number; width: number; height: number } | null = null;
let tooltipSeq = 0;
/** The tooltip view's size while hidden: room for the page to lay out the text before it reports the size. */
const TOOLTIP_ROOM = { x: 0, y: 0, width: 340, height: 400 };
let sidebarWidth = SIDEBAR_WIDTH;
/** The chat sidebar is hidden (its view stays alive, so the chat keeps running). */
let sidebarHidden = false;
/** While the divider is dragged: where the cursor started (screen x), the sidebar width then, the follow timer. */
let drag: { x: number; width: number; timer: ReturnType<typeof setInterval> } | null = null;
let server: UtilityProcess | null = null;
let settingsWin: BrowserWindow | null = null;
let changesWin: BrowserWindow | null = null;
let changesHash = "";
let changesVisible = false;
let changesProjectRequest = 0;
let changesStatus: ChangesStatus = { kind: "none" };
let vite: ViteDevServer | null = null;
/** The packaged app's page server (instead of Vite). */
let webServer: import("node:http").Server | null = null;
let appBase = ""; // the Vite origin, e.g. http://127.0.0.1:5173/
/** Vite starting (at launch, so Settings opens before a project folder is chosen), resolving to appBase. */
let webApp: Promise<string> | null = null;
/** The voice server's port, picked with Vite's proxy target before the server runs. */
let serverPort = 0;
let projectFolder: string | null = null;
/** While the chat records a turn: its start (epoch ms), for pages that load mid-turn. */
let turnFrom: number | null = null;

// ── settings: the chosen project folder, the sidebar width and the browser pane's page, kept across launches ──

interface Settings {
  instructions?: StoredInstructions;
  projectDir?: string; sidebarWidth?: number; sidebarHidden?: boolean; lastUrl?: string;
  /** Where the auxiliary windows were last left (they open there again). */
  settingsBounds?: { x: number; y: number; width: number; height: number };
  changesBounds?: { x: number; y: number; width: number; height: number };
  /** Settings' readable values (voice IDs…); the API keys are in `secrets`, encrypted (electron/secrets.ts). */
  env?: Record<string, string>;
  secrets?: Record<string, string>;
  /** The chat sidebar's own settings (its JSON): kept here, since its localStorage is lost when Vite's port changes. */
  chat?: string;
}

const settingsFile = () => join(app.getPath("userData"), "settings.json");

function readSettings(): Settings {
  try {
    return JSON.parse(readFileSync(settingsFile(), "utf8")) as Settings;
  } catch {
    return {};
  }
}

function saveSettings(patch: Settings) {
  const file = settingsFile();
  const temp = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  // The voice server reads instructions at dispatch: it must see a complete old or new settings file.
  try {
    writeFileSync(temp, JSON.stringify({ ...readSettings(), ...patch }, null, 2));
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

function loadProjectFolder(): string | null {
  const dir = readSettings().projectDir;
  return typeof dir === "string" && statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? dir : null;
}

function saveProjectFolder(dir: string) {
  saveSettings({ projectDir: dir });
}

/** safeStorage (the macOS Keychain), once the app is ready; null where it isn't available. */
function cipher(): Cipher | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return { encrypt: (text) => safeStorage.encryptString(text), decrypt: (data) => safeStorage.decryptString(data) };
}

/**
 * The saved keys in plain text, for this process and Settings. `unreadable`: API keys that couldn't be decrypted (the
 * Keychain refused, or its entry is gone): they read as not set, and Settings asks for them again.
 */
function storedEnv(): { values: Record<string, string>; unreadable: string[] } {
  const s = readSettings();
  const opened = openEnv(s, SECRET_KEYS, cipher());
  // Saved before the rename, under the old name's Keychain password: decrypt with that, save under the new one.
  const legacy = opened.unreadable.length ? legacySecrets(s, opened.unreadable, SECRET_KEYS, LEGACY_NAME) : {};
  if (Object.keys(legacy).length) {
    Object.assign(opened.env, legacy);
    opened.unreadable = opened.unreadable.filter((key) => !(key in legacy));
    opened.plaintext.push(...Object.keys(legacy));
  }
  // Saved before encryption: encrypt them now (the plain copies go).
  if (opened.plaintext.length) {
    try { saveEnv(opened.env); } catch (err) { console.error(err); }
  }
  return { values: sanitizeEnv(opened.env), unreadable: opened.unreadable };
}

/** Saves the keys: the API keys encrypted, the rest readable. */
function saveEnv(env: Record<string, string>): void {
  const sealed = sealEnv(sanitizeEnv(env), SECRET_KEYS, cipher());
  if (sealed.dropped.length) console.error(`[settings] can't encrypt, so not saving: ${sealed.dropped.join(", ")}`);
  saveSettings({ env: sealed.env, secrets: sealed.secrets });
}

async function permissionStatuses(): Promise<PermissionRow[]> {
  return [
    microphoneRow(systemPreferences.getMediaAccessStatus("microphone")),
    fullDiskRow(fullDiskAccess()),
    keychainRow(await chromeKeychainAccess()),
  ];
}

/** The chat sidebar's attention list (web/chat/attention.ts) should be fetched again. */
function attentionChanged(): void {
  sidebar?.webContents.send("attention:changed");
}

function openSettings(section?: string) {
  const target = section === "debugging" ? "preferences" : section;
  const hash = isSection(target) ? `#${target}` : "";
  if (settingsWin && !settingsWin.isDestroyed()) {
    // Settings follows its hash (hashchange) to the section.
    if (hash) void settingsWin.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
    settingsWin.focus();
    return;
  }
  // Resizable; it opens at the size and place it was left, if that's still on a screen.
  const saved = readSettings().settingsBounds;
  const onScreen = saved && screen.getAllDisplays().some(({ workArea: a }) =>
    saved.x < a.x + a.width && saved.x + saved.width > a.x && saved.y < a.y + a.height && saved.y + saved.height > a.y);
  settingsWin = new BrowserWindow({
    ...(onScreen ? saved : { width: 920, height: 760 }),
    minWidth: 560,
    minHeight: 400,
    resizable: true,
    title: "Settings",
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  const keepBounds = () => { if (settingsWin && !settingsWin.isDestroyed()) saveSettings({ settingsBounds: settingsWin.getNormalBounds() }); };
  settingsWin.on("resized", keepBounds);
  settingsWin.on("moved", keepBounds);
  settingsWin.on("closed", () => { settingsWin = null; });
  // A Vite page (web/settings.html), like the chat: it shares the chat's settings code and asks the server for voices and models.
  const w = settingsWin;
  void webAppBase().then((base) => { if (!w.isDestroyed()) void w.loadURL(`${base}settings.html${hash}`); }, (err: unknown) => console.error(err));
}

function setChangesScope(threadId?: string) {
  changesHash = threadId === undefined ? "" : `#thread=${encodeURIComponent(threadId)}`;
  updateChangesScope();
}

function updateChangesScope() {
  const wc = changesWin?.webContents;
  if (!wc || wc.isLoadingMainFrame() || wc.getURL().split("#")[0] !== `${appBase}changes.html`) return;
  // Reopening the same scope resets its checkboxes. Replacing the hash keeps the window's history flat.
  void wc.executeJavaScript(`{
    const oldURL = location.href;
    const next = new URL(oldURL);
    next.hash = ${JSON.stringify(changesHash)};
    history.replaceState(history.state, "", next);
    dispatchEvent(new HashChangeEvent("hashchange", { oldURL, newURL: next.href }));
  }`).catch(() => {});
}

function openChanges(threadId?: string) {
  if (!readChangesPreferences(settingsFile()).gitSourceControl) return;
  setChangesScope(threadId);
  if (changesWin) {
    if (!changesWin.webContents.getURL()) return; // the window will show itself after its first load
    if (changesWin.isMinimized()) changesWin.restore();
    if (!changesWin.isVisible()) changesWin.show();
    if (changesWin.isFocused()) server?.postMessage({ type: "changes-focus" });
    else changesWin.focus();
    return;
  }
  const saved = readSettings().changesBounds;
  const onScreen = saved && screen.getAllDisplays().some(({ workArea: a }) =>
    saved.x < a.x + a.width && saved.x + saved.width > a.x && saved.y < a.y + a.height && saved.y + saved.height > a.y);
  const w = changesWin = new BrowserWindow({
    ...(onScreen ? saved : { width: 920, height: 760 }),
    minWidth: 560,
    minHeight: 400,
    title: "Changes",
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, partition: "changes", preload: join(__dirname, "changes-preload.cjs") },
  });
  w.webContents.session.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  w.webContents.session.setPermissionCheckHandler(() => false);
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // This window only hosts Changes. In-page hash updates do not need a document navigation.
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  w.webContents.on("will-redirect", (e) => e.preventDefault());
  const keepBounds = () => saveSettings({ changesBounds: w.getNormalBounds() });
  w.on("resized", keepBounds);
  w.on("moved", keepBounds);
  w.on("close", keepBounds);
  const reportVisibility = () => {
    const visible = !w.isDestroyed() && w.isVisible() && !w.isMinimized();
    if (visible === changesVisible) return;
    changesVisible = visible;
    server?.postMessage({ type: "changes-visible", visible });
  };
  w.on("show", reportVisibility);
  w.on("hide", reportVisibility);
  w.on("minimize", reportVisibility);
  w.on("restore", reportVisibility);
  w.on("focus", () => server?.postMessage({ type: "changes-focus" }));
  w.on("closed", () => {
    changesWin = null;
    reportVisibility();
  });
  void webAppBase().then(async (base) => {
    if (w.isDestroyed()) return;
    const hash = changesHash;
    await w.loadURL(`${base}changes.html${hash}`);
    if (w.isDestroyed()) return;
    // A second open can arrive before the renderer is ready. Apply the latest request once loaded.
    if (hash !== changesHash) updateChangesScope();
    if (quitState === "none") w.show();
  }).catch((error) => {
    if (!w.isDestroyed()) { console.error("[changes] could not open Changes", error); w.destroy(); }
  });
}

function pageChangesStatus(status: ChangesStatus): PageChangesStatus {
  if (status.kind === "ready") return { kind: "ready", ownedThreadIds: status.ownedThreadIds };
  if (status.kind === "unavailable") return { kind: "unavailable", reason: status.reason };
  return null;
}

function openThreadChanges(threadId: string) {
  if (changesStatus.kind === "ready" && changesStatus.ownedThreadIds.includes(threadId)) openChanges(threadId);
}

function setChangesStatus(status: ChangesStatus) {
  changesStatus = status;
  const enabled = readChangesPreferences(settingsFile()).gitSourceControl;
  const wc = toolbar?.webContents;
  if (wc?.getURL() === TOOLBAR_URL) wc.send("changes:status", enabled ? status : { kind: "none" });
  const panelStatus = enabled ? pageChangesStatus(status) : null;
  browser?.webContents.send("changes:page-status", panelStatus, enabled);
  threadPanel?.setChangesStatus(panelStatus, enabled);
}

/** A JSON object's fields; {} for anything else. */
function jsonObject(json: string | undefined): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function fromSettings(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return !!settingsWin && e.sender === settingsWin.webContents;
}

/** The page the browser pane was on when the app last ran, or the home page. */
function loadLastUrl(): string {
  const url = readSettings().lastUrl;
  return typeof url === "string" && /^(https?|file):/i.test(url) ? url : HOME_PAGE;
}

/** Remembers the pane's page (web pages and files only, not about:blank, data: or error pages). */
function saveLastUrl(url: string) {
  if (!/^(https?|file):/i.test(url) || url === readSettings().lastUrl) return;
  try { saveSettings({ lastUrl: url }); } catch (err) { console.error(err); }
}

// ── processes ──

/** A free local port (the server and Vite each take one). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Starts the voice server on `port` and resolves once it is listening. */
function startServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server = utilityProcess.fork(join(__dirname, "server.mjs"), [], {
      env: {
        ...process.env,
        APP_ROOT: FILES_ROOT + "/",
        SPEECH_DATA_DIR: SPEECH_DIR,
        // Packaged: its turn logs and its saved LLM / speech selections in its own folder (not the repo's, nor
        // ~/.config/vizzo, which `npm run dev` uses).
        ...(app.isPackaged ? {
          RESULTS_DIR: process.env.RESULTS_DIR ?? join(app.getPath("userData"), "results"),
          LLM_SELECTION_FILE: process.env.LLM_SELECTION_FILE ?? join(app.getPath("userData"), "llm-selection.json"),
          SPEECH_SELECTION_FILE: process.env.SPEECH_SELECTION_FILE ?? join(app.getPath("userData"), "speech-selection.json"),
          VIZZO_THREADS_FILE: process.env.VIZZO_THREADS_FILE ?? join(app.getPath("userData"), "threads.json"),
        } : {}),
        PORT: String(port),
        PROJECT_DIR: projectFolder ?? "",
        VIZZO_SETTINGS_FILE: settingsFile(),
      },
      stdio: "inherit",
    });
    server.once("message", (msg: { type: string }) => {
      if (msg.type === "ready") resolve();
    });
    server.on("message", onServerMessage);
    server.once("exit", (code) => reject(new Error(`voice server exited (${code}) before it was ready`)));
  });
}

/** Vite serves the chat UI; vite.config.ts proxies /api and /ws to the voice server (PORT). Packaged: webServer.ts. */
async function startWebApp(serverPort: number): Promise<string> {
  if (app.isPackaged) {
    const web = await startWebServer(join(ROOT, "dist"), serverPort);
    webServer = web.server;
    return `http://127.0.0.1:${web.port}/`;
  }
  process.env.PORT = String(serverPort);
  const { createServer } = await import("vite");
  vite = await createServer({
    configFile: join(ROOT, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 5173 },
  });
  await vite.listen();
  const { port } = vite.httpServer!.address() as AddressInfo;
  return `http://127.0.0.1:${port}/`;
}

/** Starts Vite once, proxying to the port the voice server will take. */
function webAppBase(): Promise<string> {
  webApp ??= freePort().then((port) => {
    serverPort = port;
    return startWebApp(port);
  }).then((base) => (appBase = base));
  return webApp;
}

let voiceStart: Promise<void> | null = null;
/**
 * Starts the voice server, once: at launch, with or without a project folder. Without one its agents wait in an
 * empty temp folder (server/adapters/claudeCli.ts EMPTY_CWD), so Settings can scan the harnesses, list the models
 * and load the speech engines before a folder is chosen, and the first run picks its models (server/llmSelection.ts).
 */
function startVoiceServer(): Promise<void> {
  voiceStart ??= webAppBase().then(() => startServer(serverPort));
  return voiceStart;
}

let chatShown = false;
/** Puts the chat in the sidebar (in place of the gate) once a project folder is chosen. Runs once. */
async function startBackend() {
  if (chatShown) return;
  chatShown = true;
  const base = await webAppBase();
  await startVoiceServer();
  sidebar?.webContents.loadURL(`${base}chat.html`);
  reportPage(browser?.webContents ?? null);
}

// ── browser pane ──

/** "localhost:5173" → http://…, "example.com" → https://…, anything with spaces → a search. */
function toUrl(input: string): string {
  const text = input.trim();
  if (!text) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data):/i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  if (/\s/.test(text) || !text.includes(".")) return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
  return `https://${text}`;
}

/** Pushes the browser's URL, title and history state to the address bar. */
function sendState(wc: WebContents) {
  // The page's preload too: a side button or a swipe navigates only where history has an entry (historyNav.ts).
  wc.send("page:history-state", historyState(wc));
  toolbar?.webContents.send("nav-state", {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
  });
}

const historyState = (wc: WebContents) => ({ back: wc.navigationHistory.canGoBack(), forward: wc.navigationHistory.canGoForward() });

/**
 * A safety net under the page's own momentum handling (historyNav.ts): one trackpad swipe navigation per this long.
 * Short enough for swiping back several pages in a row.
 */
const SWIPE_NAV_COOLDOWN_MS = 300;
let lastSwipeNav = 0;

/**
 * Back or forward in the browser pane. `via`: "button" (mouse buttons 4/5 on the page), "swipe" (two-finger trackpad
 * swipe, from wheel events on the page) or "gesture" (a macOS swipe event: three-finger swipes, and mice whose
 * software sends back/forward as one, like Logi Options+'s Back/Forward).
 */
// DEBUG-HISTORY (temporary)
const historyDebug = (line: string) => { try { require("node:fs").appendFileSync('/private/tmp/claude-501/-Users-j-Sites-vizzo/aa977892-3ab7-43ed-a726-2940189693f5/scratchpad/history-debug.log', `${new Date().toISOString()} ${line}\n`); } catch {} };
function goHistory(dir: unknown, via: unknown) {
  historyDebug(`goHistory ${String(dir)} via ${String(via)}`);
  const wc = currentPage();
  if (!wc || (dir !== "back" && dir !== "forward")) return;
  if (via === "swipe") {
    if (Date.now() - lastSwipeNav < SWIPE_NAV_COOLDOWN_MS) return;
    lastSwipeNav = Date.now();
  }
  if (dir === "back") wc.navigationHistory.goBack();
  else wc.navigationHistory.goForward();
}

/** Tells the server which page the browser is on (sent with each turn). */
function reportPage(wc: WebContents | null) {
  if (!wc || !server) return;
  server.postMessage({ type: "page", url: wc.getURL() || null });
}

/** Tells the chat sidebar the browser pane's URL (it sends the page the threads that belong to it). */
function sendPageUrl() {
  const url = browser?.webContents.getURL();
  if (url) sidebar?.webContents.send("page:url", url);
}

/** Right-click → Inspect Element, like a browser. In the browser pane, also Add feedback on the element there. */
function addInspect(wc: WebContents, feedback = false) {
  wc.on("context-menu", (_event, params) => {
    Menu.buildFromTemplate([
      ...(feedback ? [
        { label: "Add feedback", click: () => wc.send("page:comment-at", { x: params.x, y: params.y }) },
        { type: "separator" as const },
      ] : []),
      { label: "Inspect Element", click: () => wc.inspectElement(params.x, params.y) },
    ]).popup();
  });
}

/** The sidebar width within the limits for a window `width` wide (when it can't fit both, the sidebar wins). */
function clampSidebar(w: number, width: number): number {
  return Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(w, width - MIN_PANE_WIDTH)));
}

function layout() {
  if (!win || !toolbar || !folderBar || !browser || !sidebar || !divider) return;
  const [width = 0, height = 0] = win.getContentSize();
  const side = sidebarHidden ? 0 : Math.min(width, clampSidebar(sidebarWidth, width));
  const paneWidth = Math.max(0, width - side);
  // With the sidebar hidden, the browser pane takes the whole width and the address bar ends before the folder bar.
  const topWidth = sidebarHidden ? Math.max(0, width - COLLAPSED_BAR_WIDTH) : paneWidth;
  const below = Math.max(0, height - TOOLBAR_HEIGHT);
  toolbar.setBounds({ x: 0, y: 0, width: topWidth, height: TOOLBAR_HEIGHT });
  folderBar.setBounds({ x: topWidth, y: 0, width: width - topWidth, height: TOOLBAR_HEIGHT });
  browser.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: paneWidth, height: below });
  threadPanel?.layout();
  sidebar.setBounds({ x: paneWidth, y: TOOLBAR_HEIGHT, width: side, height: below });
  // The divider runs the full height, through the address bar, so the split is one line. While dragging it covers
  // the window so it keeps the pointer over the other views. Hidden, it has no size.
  if (sidebarHidden && !drag) divider.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  else divider.setBounds(drag
    ? { x: 0, y: 0, width, height }
    : { x: paneWidth - Math.floor(DIVIDER_WIDTH / 2), y: 0, width: DIVIDER_WIDTH, height });
}

/** Shows or hides the chat sidebar, and tells the folder bar so it shows only its toggle while hidden. */
function toggleSidebar() {
  sidebarHidden = !sidebarHidden;
  layout();
  folderBar?.webContents.send("sidebar-hidden", sidebarHidden);
  try { saveSettings({ sidebarHidden }); } catch (err) { console.error(err); }
}

/**
 * Divider drag (shell/divider.html sends start and end). The cursor is read from the OS at ~60 Hz rather than
 * taken from the page's events, whose coordinates can't be trusted while the view is being moved and resized.
 * Dragging left widens the sidebar.
 */
function startDrag() {
  if (!win || drag) return;
  const [width = 0] = win.getContentSize();
  drag = { x: screen.getCursorScreenPoint().x, width: clampSidebar(sidebarWidth, width), timer: setInterval(followCursor, 16) };
  layout();
}

function followCursor() {
  if (!win || !drag) return;
  const [width = 0] = win.getContentSize();
  const next = clampSidebar(drag.width + drag.x - screen.getCursorScreenPoint().x, width);
  if (next === sidebarWidth) return;
  sidebarWidth = next;
  layout();
}

function endDrag() {
  if (!drag) return;
  followCursor();
  clearInterval(drag.timer);
  drag = null;
  saveSettings({ sidebarWidth });
  layout();
}

function currentPage(): WebContents | null {
  return browser?.webContents ?? null;
}

function toggleInspector() {
  const wc = currentPage();
  if (!wc) return;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: "right" });
}

// ── window ──

// Comment mode (the toolbar's pointer button): kept here, shown in the toolbar, applied by the browser pane
// (web/cursor/commentOverlay.ts), whose bubble talks to the chat sidebar.
let commentMode = false;
let drawingMode = false;
let drawingDisabledReason: string | null = "Loading model settings…";
let drawingPreviewIsOpen = false;
function setDrawingMode(on: boolean) {
  if (on && drawingDisabledReason !== null) return;
  if (on && commentMode) setCommentMode(false);
  drawingMode = on;
  threadPanel?.drawing(on);
  toolbar?.webContents.send("drawing:state", on);
  browser?.webContents.send("page:drawing-mode", on);
  if (on) browser?.webContents.focus();
}
/** Comment mode is on only while the comment key is held (it was off when the key went down). */
let commentHeld = false;
let commentHeldAt = 0;
/** A comment-key press shorter than this is a tap: comment mode stays on. */
const COMMENT_TAP_MS = 300;
/** keepDraft: an empty bubble stays open (letting go of the comment key after clicking an element). */
function setCommentMode(on: boolean, keepDraft = false) {
  if (on && drawingMode) setDrawingMode(false);
  commentHeld = false;
  commentMode = on;
  toolbar?.webContents.send("comment:state", commentMode);
  browser?.webContents.send("page:comment-mode", commentMode, keepDraft);
}
/**
 * The comment key (Settings → Keyboard, Ctrl+M by default), wherever focus is: a tap turns comment mode on or off;
 * held while it was off, it's on until the key comes up.
 */
function commentKey(input: Electron.Input) {
  if (input.isAutoRepeat) return;
  const hk = hotkeys().comment;
  if (input.type === "keyDown" && matchesDown(fromElectronInput(input), hk)) {
    if (commentMode) return setCommentMode(false);
    setCommentMode(true);
    commentHeld = true;
    commentHeldAt = Date.now();
  } else if (input.type === "keyUp" && commentHeld && endsHold(input, hk)) {
    if (Date.now() - commentHeldAt < COMMENT_TAP_MS) commentHeld = false;
    else setCommentMode(false, true);
  }
}

/** The toolbar's --chrome (shared/theme.ts) for the system theme. */
const windowBackground = () => THEME[nativeTheme.shouldUseDarkColors ? "dark" : "light"].chrome;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: APP_NAME,
    titleBarStyle: "hiddenInset",
    backgroundColor: windowBackground(),
  });
  // Behind the views (seen while resizing): the shell's bar colour, light or dark with the system.
  const onTheme = () => win?.setBackgroundColor(windowBackground());
  nativeTheme.on("updated", onTheme);
  win.on("closed", () => {
    nativeTheme.off("updated", onTheme);
    if (drag) clearInterval(drag.timer);
    settingsWin?.close();
    changesWin?.close();
    threadPanel = null; win = null; toolbar = null; folderBar = null; browser = null; sidebar = null; divider = null; tooltip = null; tooltipPending = null; drag = null;
  });
  win.on("resize", layout);
  // macOS: closing the window keeps the app running (its threads, jobs and turns go on); the Dock icon brings it back.
  // Elsewhere closing it quits, asking first while something works (the window stays until then: its chat holds the
  // background jobs).
  win.on("close", (e) => {
    if (quitState === "now") return;
    e.preventDefault();
    if (process.platform === "darwin") win?.hide();
    else void requestQuit();
  });
  // macOS swipe events come to the window: three-finger swipes (System Settings → Trackpad → Swipe between pages:
  // three fingers), and mouse buttons that Logi Options+ maps to Back/Forward (it sends them as swipes). Two-finger
  // swipes come to the page as wheel events instead (historyNav.ts). Checked with an MX Master 3 on Logi Options+:
  // its Back button arrives as "right", Forward as "left".
  win.on("swipe", (_e, direction) => {
    historyDebug(`window swipe ${direction}`);
    if (direction === "right") goHistory("back", "gesture");
    else if (direction === "left") goHistory("forward", "gesture");
  });

  const appPrefs = { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true };

  toolbar = new WebContentsView({ webPreferences: appPrefs });
  toolbar.setBackgroundColor("#00000000");
  toolbar.webContents.loadFile(TOOLBAR_FILE);
  win.contentView.addChildView(toolbar);

  folderBar = new WebContentsView({ webPreferences: appPrefs });
  folderBar.setBackgroundColor("#00000000");
  folderBar.webContents.loadFile(join(__dirname, "shell", "folder.html"));
  // A sidebar hidden at the last quit starts hidden: the folder bar shows only its toggle.
  folderBar.webContents.once("did-finish-load", () => { if (sidebarHidden) folderBar?.webContents.send("sidebar-hidden", true); });
  win.contentView.addChildView(folderBar);

  // The browser pane has its own session, and no site gets any permission.
  // Its preload records what the chat needs from the page (push-to-talk, pointer, clicks, highlights) and draws
  // the turn's pointing targets; see page-preload.ts.
  browser = new WebContentsView({
    webPreferences: { partition: "persist:browser", additionalArguments: ["--vizzo-thread-panel"], preload: join(__dirname, "page-preload.cjs"), contextIsolation: true, sandbox: true },
  });
  browser.webContents.session.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  win.contentView.addChildView(browser);

  // The chat sidebar: the microphone is allowed (voice chat), other permissions are not.
  sidebar = new WebContentsView({ webPreferences: appPrefs });
  sidebar.webContents.session.setPermissionRequestHandler((_wc, permission, done) => done(permission === "media"));
  win.contentView.addChildView(sidebar);
  const pageView = browser;
  threadPanel = installThreadPanel(win, pageView.webContents, () => pageView.getBounds(), __dirname,
    (channel, ...args) => sidebar?.webContents.send(channel, ...args), openThreadChanges);
  setChangesStatus(changesStatus);

  // Drag handle between the browser pane and the sidebar; added last, so it's on top of both.
  divider = new WebContentsView({ webPreferences: appPrefs });
  divider.setBackgroundColor("#00000000");
  divider.webContents.loadFile(join(__dirname, "shell", "divider.html"));
  win.contentView.addChildView(divider);

  tooltip = new WebContentsView({ webPreferences: appPrefs });
  tooltip.setBackgroundColor("#00000000");
  tooltip.setBounds(TOOLTIP_ROOM);
  tooltip.setVisible(false);
  tooltip.webContents.loadFile(join(__dirname, "shell", "tooltip.html"));
  win.contentView.addChildView(tooltip);
  layout();

  // Esc while focus is in the toolbar (after clicking the pointer button) or the sidebar leaves comment mode too;
  // the key still reaches that view. The page handles its own Esc (an empty bubble closes first).
  for (const view of [toolbar, sidebar]) {
    view.webContents.on("before-input-event", (_e, input) => {
      if (drawingMode && input.type === "keyDown" && input.key === "Escape" && !input.isAutoRepeat) setDrawingMode(false);
      if (commentMode && input.type === "keyDown" && input.key === "Escape" && !input.isAutoRepeat) setCommentMode(false);
    });
  }
  for (const view of [toolbar, sidebar, browser, threadPanel.view]) view.webContents.on("before-input-event", (_e, input) => commentKey(input));
  // Esc stops the voice wherever focus is (three in a row ask to stop its task too): the sidebar handles its own Esc,
  // the browser pane's and the toolbar's are relayed (the key still reaches the page, so its own Esc works as before).
  for (const view of [toolbar, browser, threadPanel.view]) {
    view.webContents.on("before-input-event", (_e, input) => {
      if (input.type === "keyDown" && input.key === "Escape" && !input.isAutoRepeat && !drawingPreviewIsOpen && !threadPanel?.previewOpen()) sidebar?.webContents.send("escape");
    });
  }
  // The key can come up in another app: a held mode ends when the window loses focus.
  win.on("blur", () => { if (commentHeld) setCommentMode(false, true); });
  // Back from System Settings (a permission granted): the sidebar checks what still needs attention.
  win.on("focus", attentionChanged);

  const wc = browser.webContents;
  installPageReload(wc, () => {
    const enabled = readChangesPreferences(settingsFile()).gitSourceControl;
    wc.send("changes:page-status", enabled ? pageChangesStatus(changesStatus) : null, enabled);
    sendPageUrl();
  }, down => sidebar?.webContents.send("ptt", down));
  addInspect(wc, true);
  addInspect(sidebar.webContents);
  // Links that open a new window open as a page in the browser pane, not a second Electron window.
  wc.setWindowOpenHandler(({ url }) => {
    wc.loadURL(url);
    return { action: "deny" };
  });
  const navigated = () => { drawingPreviewIsOpen = false; setDrawingMode(false); wc.send("page:drawing-clear"); reportPage(wc); saveLastUrl(wc.getURL()); sendPageUrl(); };
  wc.on("did-navigate", navigated);
  wc.on("did-navigate-in-page", navigated);
  const navigationState = () => sendState(wc);
  wc.on("did-navigate", navigationState);
  wc.on("did-navigate-in-page", navigationState);
  wc.on("page-title-updated", navigationState);
  wc.on("did-start-loading", navigationState);
  wc.on("did-stop-loading", navigationState);
  toolbar.webContents.once("did-finish-load", () => sendState(wc));
  wc.loadURL(loadLastUrl());

  // The voice server starts either way; until a folder is chosen, the sidebar shows the gate instead of the chat.
  void startVoiceServer().catch(fail);
  if (projectFolder) void startBackend().catch(fail);
  else sidebar.webContents.loadFile(join(__dirname, "shell", "gate.html"));
}

// ── project folder ──

/** Makes `dir` the project folder: saved, handed to the server (which restarts its claude -p agents there). */
async function setProjectFolder(dir: string) {
  const previous = projectFolder;
  projectFolder = dir;
  saveProjectFolder(dir);
  if (previous !== dir) setChangesScope();
  const request = ++changesProjectRequest;
  setChangesStatus({ kind: "loading" });
  settingsWin?.webContents.send("project-changed", dir);
  // Started at launch (maybe without a folder, or still starting): it gets the folder once it's listening.
  await startVoiceServer();
  server?.postMessage({ type: "project", dir, changesRequest: request });
  await startBackend();
  sidebar?.webContents.send("project-changed", projectFolder);
}

async function pickProjectFolder(): Promise<string | null> {
  const result = await dialog.showOpenDialog(win!, {
    title: "Choose the project folder",
    buttonLabel: "Use Folder",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: projectFolder ?? undefined,
  });
  if (!result.canceled && result.filePaths[0]) await setProjectFolder(result.filePaths[0]);
  return projectFolder;
}

// ── cookie import ──

const BROWSER_LABEL: Record<BrowserId, string> = { chrome: "Chrome", safari: "Safari", firefox: "Firefox" };

function importSummary(browser: BrowserId, imported: number, failed: number, firstError?: string): string {
  const name = BROWSER_LABEL[browser];
  if (imported === 0) {
    const detail = firstError ? ` ${firstError}` : "";
    return firstError ? `Could not store ${name} cookies.${detail}` : `No cookies to import from ${name}.`;
  }
  const count = `${imported} cookie${imported === 1 ? "" : "s"}`;
  return failed ? `Imported ${count} from ${name}. ${failed} could not be stored.` : `Imported ${count} from ${name}.`;
}

/** Copies another browser's cookies into the pane's session, then reloads so the page sends them. */
async function importCookies(browserName: BrowserId): Promise<{ imported: number; failed: number; message: string }> {
  let stored;
  try {
    stored = await readBrowserCookies(browserName);
  } catch (err) {
    const message = err instanceof CookieReadError ? err.message : `Could not read ${BROWSER_LABEL[browserName]} cookies.`;
    return { imported: 0, failed: 0, message };
  }
  const now = Date.now() / 1000;
  const details: ElectronCookie[] = [];
  for (const cookie of stored) {
    const next = toElectronCookie(cookie, now);
    if (next) details.push(next);
  }
  if (!details.length) return { imported: 0, failed: 0, message: `No cookies to import from ${BROWSER_LABEL[browserName]}.` };

  const ses = browser?.webContents.session;
  if (!ses) return { imported: 0, failed: 0, message: "The browser window is not open." };
  let imported = 0;
  let failed = 0;
  let firstError: string | undefined;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const cookie = details[cursor];
      cursor += 1;
      if (!cookie) return;
      try {
        await ses.cookies.set(cookie);
        imported += 1;
      } catch (err) {
        failed += 1;
        if (!firstError) firstError = (err instanceof Error ? err.message : String(err)).slice(0, 180);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(32, details.length) }, () => worker()));
  if (imported > 0) currentPage()?.reloadIgnoringCache();
  return { imported, failed, message: importSummary(browserName, imported, failed, firstError) };
}

/** Deletes every cookie in the pane's own session (not the other browsers'), then reloads so the page goes without them. */
async function clearCookies(): Promise<{ cleared: number; message: string }> {
  const ses = browser?.webContents.session;
  if (!ses) return { cleared: 0, message: "The browser window is not open." };
  const cleared = (await ses.cookies.get({})).length;
  await ses.clearStorageData({ storages: ["cookies"] });
  if (cleared > 0) currentPage()?.reloadIgnoringCache();
  return { cleared, message: cleared ? `Cleared ${cleared} cookie${cleared === 1 ? "" : "s"}.` : "No cookies to clear." };
}

// ── wiring ──

function registerIpc() {
  const fromChangesToolbar = (e: IpcMainInvokeEvent) => e.sender === toolbar?.webContents
    && e.senderFrame === e.sender.mainFrame && e.senderFrame?.url === TOOLBAR_URL;
  ipcMain.handle("changes:get-status", (e) =>
    fromChangesToolbar(e) && readChangesPreferences(settingsFile()).gitSourceControl ? changesStatus : null);
  ipcMain.handle("changes:open", (e) => {
    if (fromChangesToolbar(e) && (changesStatus.kind === "ready" || changesStatus.kind === "unavailable")) openChanges();
  });
  const fromChanges = (e: IpcMainEvent) => e.sender === changesWin?.webContents && e.senderFrame === e.sender.mainFrame
    && appBase !== "" && e.senderFrame?.url.split("#")[0] === `${appBase}changes.html`;
  ipcMain.on("changes:auto-message:get", (e) => {
    const prefs = readChangesPreferences(settingsFile());
    e.returnValue = fromChanges(e) && prefs.gitSourceControl && prefs.autoCommitMessage;
  });
  ipcMain.on("changes:auto-message:set", (e, enabled: unknown) => {
    if (!fromChanges(e) || typeof enabled !== "boolean" || !readChangesPreferences(settingsFile()).gitSourceControl) {
      e.returnValue = false;
      return;
    }
    const chat = JSON.stringify({ ...jsonObject(readSettings().chat), autoCommitMessage: enabled });
    try { saveSettings({ chat }); }
    catch (error) {
      console.warn("[changes] could not save the automatic commit-message preference", error);
      e.returnValue = false;
      return;
    }
    sidebar?.webContents.send("chat-settings:changed", chat);
    e.returnValue = true;
  });
  ipcMain.handle("nav:go", (_e, input: string) => {
    const url = toUrl(input);
    if (url) currentPage()?.loadURL(url);
  });
  ipcMain.handle("nav:back", () => currentPage()?.navigationHistory.goBack());
  ipcMain.handle("nav:forward", () => currentPage()?.navigationHistory.goForward());
  ipcMain.handle("nav:reload", () => currentPage()?.reload());
  ipcMain.handle("nav:stop", () => currentPage()?.stop());
  ipcMain.handle("project:get", () => projectFolder);
  ipcMain.handle("cookies:import", (e, browserName: unknown) => {
    if (!fromSettings(e)) return { imported: 0, failed: 0, message: "Cookies can only be imported from Settings." };
    if (browserName !== "chrome" && browserName !== "safari" && browserName !== "firefox") {
      return { imported: 0, failed: 0, message: "Unknown browser." };
    }
    return importCookies(browserName);
  });
  ipcMain.handle("cookies:clear", (e) => {
    if (!fromSettings(e)) return { cleared: 0, message: "Cookies can only be cleared from Settings." };
    return clearCookies();
  });
  ipcMain.handle("project:pick", () => pickProjectFolder());
  ipcMain.handle("settings:open", (e, section: unknown) => {
    if (e.sender !== folderBar?.webContents && e.sender !== sidebar?.webContents) return;
    openSettings(typeof section === "string" ? section : undefined);
  });
  // What needs attention, for the chat sidebar (web/chat/attention.ts): the permissions, which keys are set (never
  // their values) and their labels, and the keys macOS wouldn't decrypt. It's told when Settings changes any of them.
  ipcMain.handle("attention:get", (e) => {
    if (!sidebar || e.sender !== sidebar.webContents) return null;
    const { values, unreadable } = storedEnv();
    return {
      // Only the microphone is required. Cookie import permissions belong in Settings, and checking the
      // Chrome keychain runs Swift. This stays cheap when the window comes back into focus.
      permissions: [microphoneRow(systemPreferences.getMediaAccessStatus("microphone"))],
      set: Object.keys(values).filter((k) => values[k]?.trim()),
      labels: Object.fromEntries(ENV_FIELDS.map((f) => [f.key, f.label])),
      unreadable,
    };
  });
  ipcMain.handle("settings:get", (e) => {
    if (!fromSettings(e)) return null;
    const { values, unreadable } = storedEnv();
    return permissionStatuses().then((permissions) => ({ permissions, fields: ENV_FIELDS, values, unreadable }));
  });
  ipcMain.handle("instructions:get", (e) => {
    if (!fromSettings(e)) throw new Error("Instructions are available in Settings.");
    return instructionSnapshot(readSettings().instructions, projectFolder);
  });
  ipcMain.handle("instructions:save", (e, edit: unknown) => {
    if (!fromSettings(e)) throw new Error("Instructions can only be edited in Settings.");
    saveSettings({ instructions: editInstructions(readSettings().instructions, edit) });
    server?.postMessage({ type: "instructions" });
  });
  ipcMain.handle("settings:refresh", (e) => {
    if (!fromSettings(e)) return [];
    attentionChanged();
    return permissionStatuses();
  });
  ipcMain.handle("settings:allow-microphone", async (e) => {
    if (!fromSettings(e)) return [];
    await systemPreferences.askForMediaAccess("microphone");
    attentionChanged();
    return permissionStatuses();
  });
  // Reading Chrome's Safe Storage password is what shows the macOS keychain prompt; a refusal just re-checks.
  ipcMain.handle("settings:allow-keychain", async (e) => {
    if (!fromSettings(e)) return [];
    await chromeSafeStoragePassword().catch(() => undefined);
    attentionChanged();
    return permissionStatuses();
  });
  ipcMain.handle("settings:open-privacy", (e, pane: unknown) => {
    if (!fromSettings(e)) return;
    const url = pane === "full-disk"
      ? "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
      : "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
    return shell.openExternal(url);
  });
  ipcMain.handle("settings:save", (e, values: unknown) => {
    if (!fromSettings(e)) return;
    const env = sanitizeEnv(values);
    saveEnv(env);
    applyEnv(env);
    server?.postMessage({ type: "env", env });
    attentionChanged();
  });
  ipcMain.on("sidebar:toggle", (e) => {
    if (folderBar && e.sender === folderBar.webContents) toggleSidebar();
  });
  // Hover tooltips: a view asks for one at its element's rect, the tooltip page lays it out and reports its size,
  // then it's placed below the element (above it when there's no room) and raised over every view.
  ipcMain.on("tooltip:show", (e, req: unknown) => {
    const view = [toolbar, folderBar, browser, sidebar, threadPanel?.view].find((v) => v?.webContents === e.sender);
    const r = req as { text?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
    if (!view || !tooltip || typeof r?.text !== "string" || ![r.x, r.y, r.width, r.height].every((n) => typeof n === "number")) return;
    const zoom = e.sender.getZoomFactor();
    const b = view.getBounds();
    tooltipPending = {
      id: ++tooltipSeq,
      x: b.x + (r.x as number) * zoom, y: b.y + (r.y as number) * zoom,
      width: (r.width as number) * zoom, height: (r.height as number) * zoom,
    };
    tooltip.webContents.send("tooltip:text", tooltipPending.id, r.text.slice(0, 2000));
  });
  ipcMain.on("tooltip:size", (e, id: unknown, w: unknown, h: unknown) => {
    const a = tooltipPending;
    if (!win || !tooltip || e.sender !== tooltip.webContents || !a || id !== a.id || typeof w !== "number" || typeof h !== "number") return;
    const [width = 0, height = 0] = win.getContentSize();
    const GAP = 6, EDGE = 4;
    const x = Math.round(Math.max(EDGE, Math.min(a.x + a.width / 2 - w / 2, width - w - EDGE)));
    const below = a.y + a.height + GAP;
    const y = Math.round(below + h <= height - EDGE ? below : Math.max(EDGE, a.y - h - GAP));
    tooltip.setBounds({ x, y, width: w, height: h });
    win.contentView.addChildView(tooltip); // re-adding raises it above the folder bar's overlay
    tooltip.setVisible(true);
  });
  ipcMain.on("tooltip:hide", () => {
    tooltipPending = null;
    if (!tooltip) return;
    tooltip.setVisible(false);
    tooltip.setBounds(TOOLTIP_ROOM);
  });
  ipcMain.on("divider", (e, phase: unknown) => {
    if (!divider || e.sender !== divider.webContents) return;
    if (phase === "start") startDrag();
    else if (phase === "end") endDrag();
  });
  // Browser pane ↔ chat sidebar (web/cursor/pageBridge.ts). Each side only accepts messages from the other.
  const fromPage = (e: IpcMainEvent | IpcMainInvokeEvent) => !!browser && e.sender === browser.webContents;
  for (const channel of ["page:samples", "page:events"]) {
    ipcMain.on(channel, (e, msg: unknown) => {
      if (fromPage(e)) sidebar?.webContents.send(channel, msg);
    });
  }
  ipcMain.on("page:cmd", (e, cmd: PageCmd) => {
    if (!sidebar || e.sender !== sidebar.webContents) return;
    if (cmd.type === "start") turnFrom = cmd.t ?? null;
    else if (cmd.type === "stop" || cmd.type === "clear") turnFrom = null;
    threadPanel?.command(cmd);
    if (!("surface" in cmd && cmd.surface === "panel")) browser?.webContents.send("page:cmd", cmd);
  });
  // A page that loads mid-turn asks whether to record.
  ipcMain.handle("page:state", (e) => (fromPage(e) ? { tFrom: turnFrom } : null));
  // Element threads. A document that's ready for commands (load, reload, HMR full reload) gets its threads again.
  const fromSidebar = (e: IpcMainEvent | IpcMainInvokeEvent) => !!sidebar && e.sender === sidebar.webContents;
  ipcMain.handle("clipboard:write", (e, text: unknown) => {
    if (!(fromSidebar(e) || fromPage(e) || e.sender === threadPanel?.view.webContents) || typeof text !== "string") throw new Error("Clipboard unavailable");
    return clipboard.writeText(text);
  });
  ipcMain.handle("session:release", async (e, sessionId: unknown) => {
    if (!(fromSidebar(e) || fromPage(e) || e.sender === threadPanel?.view.webContents) || typeof sessionId !== "string" || !sessionId) throw new Error("Session unavailable");
    await prepareSessionResume(sessionId, `http://127.0.0.1:${serverPort}`);
  });
  ipcMain.handle("session:continue", async (e, sessionId: unknown, context: unknown) => {
    if (!(fromSidebar(e) || fromPage(e) || e.sender === threadPanel?.view.webContents) || typeof sessionId !== "string" || !sessionId) throw new Error("Session unavailable");
    await continueSession(sessionId, `http://127.0.0.1:${serverPort}`, typeof context === "string" ? context : undefined);
  });
  // The chat's settings (read synchronously: the sidebar needs them before it builds its UI). The sidebar and the
  // Settings window each save only the keys they change (web/chat/settings.ts); they're merged here, and the
  // sidebar gets what Settings changed.
  ipcMain.on("chat-settings:get", (e) => { e.returnValue = fromSidebar(e) || fromSettings(e) ? readSettings().chat ?? null : null; });
  ipcMain.on("chat-settings:save", (e, json: unknown) => {
    if (!(fromSidebar(e) || fromSettings(e)) || typeof json !== "string" || json.length >= 200_000) return;
    const prior = jsonObject(readSettings().chat);
    const patch = jsonObject(json);
    const settingsFrame = fromSettings(e) && e.senderFrame === e.sender.mainFrame
      && appBase !== "" && e.senderFrame?.url.split("#")[0] === `${appBase}settings.html`;
    if (!settingsFrame) {
      delete patch.gitSourceControl;
      delete patch.commitMessageTier;
      delete patch.commitMessageTimeoutSeconds;
    }
    // Only the Changes window owns this preference.
    delete patch.autoCommitMessage;
    const chat = { ...prior, ...patch };
    const merged = JSON.stringify(chat);
    saveSettings({ chat: merged });
    const enabled = readChangesPreferences(settingsFile()).gitSourceControl;
    if (enabled !== changesPreferences(prior).gitSourceControl) {
      if (!enabled) changesWin?.destroy();
      setChangesStatus({ kind: enabled ? "loading" : "none" });
      server?.postMessage({ type: "changes-preference" });
    }
    if (fromSettings(e)) sidebar?.webContents.send("chat-settings:changed", merged);
    setHotkeys(chat.hotkeys);
  });
  // The keyboard shortcuts (shared/hotkeys.ts), saved with the chat's settings: the preloads read them at load and
  // hear each change (the sidebar's page has them from its settings).
  ipcMain.on("hotkeys:get", (e) => { e.returnValue = hotkeys(); });
  onHotkeys((hk) => { for (const view of [toolbar, folderBar, browser, sidebar, threadPanel?.view]) view?.webContents.send("hotkeys", hk); });
  ipcMain.handle("page:url", (e) => (fromSidebar(e) ? browser?.webContents.getURL() || null : null));
  ipcMain.on("page:thread", (e, action: unknown) => {
    if (!fromPage(e)) return;
    if (isPageThreadAction(action) && action.type === "thread.commit") {
      if (e.senderFrame === e.sender.mainFrame) openThreadChanges(action.threadId);
      return;
    }
    sidebar?.webContents.send("page:thread", action);
  });
  ipcMain.on("page:open-thread", (e, threadId: unknown) => {
    if (fromSidebar(e) && typeof threadId === "string") browser?.webContents.send("page:open-thread", threadId);
  });
  // Feedback queue: the toolbar's Instant toggle and Send button ↔ the chat sidebar, which holds the queued turns.
  let queueState: unknown = null;
  ipcMain.handle("queue:get", (e) => (toolbar && e.sender === toolbar.webContents ? queueState : null));
  ipcMain.on("queue:state", (e, state: unknown) => {
    if (!fromSidebar(e)) return;
    queueState = state;
    toolbar?.webContents.send("queue:state", state);
  });
  ipcMain.on("queue:cmd", (e, cmd: unknown) => {
    if (toolbar && e.sender === toolbar.webContents) sidebar?.webContents.send("queue:cmd", cmd);
  });
  // Comment mode: the toolbar and the page (Esc there, web/cursor/commentOverlay.ts) set it; see setCommentMode.
  const fromToolbar = (e: IpcMainEvent | IpcMainInvokeEvent) => !!toolbar && e.sender === toolbar.webContents;
  const fromFolderBar = (e: IpcMainEvent | IpcMainInvokeEvent) => !!folderBar && e.sender === folderBar.webContents;
  // Shift in a top bar is push-to-talk. On release the sidebar takes the keyboard, so the next Shift (and Esc) go there.
  ipcMain.on("bar:ptt", (e, down: unknown) => {
    if (!fromToolbar(e) && !fromFolderBar(e)) return;
    sidebar?.webContents.send("ptt", down === true);
    if (down !== true && !sidebarHidden && win?.isFocused()) sidebar?.webContents.focus();
  });
  ipcMain.on("page:drawing-preview", (e, on: unknown) => {
    if (fromPage(e)) drawingPreviewIsOpen = on === true;
  });
  ipcMain.handle("drawing:get", (e) => (fromToolbar(e) || fromPage(e) ? drawingMode : null));
  ipcMain.handle("drawing:disabled-reason:get", (e) => (fromToolbar(e) ? drawingDisabledReason : null));
  ipcMain.on("drawing:disabled-reason", (e, reason: unknown) => {
    if (!fromSidebar(e) || !(reason === null || (typeof reason === "string" && reason.length > 0 && reason.length <= 500))) return;
    drawingDisabledReason = reason;
    if (reason !== null && drawingMode) setDrawingMode(false);
    toolbar?.webContents.send("drawing:disabled-reason", reason);
  });
  ipcMain.on("drawing:mode", (e, on: unknown) => {
    if (fromToolbar(e) || fromPage(e)) setDrawingMode(on === true);
  });
  ipcMain.handle("page:drawing-capture", async (e) => {
    if (!fromPage(e) || !drawingMode || !browser) return null;
    tooltip?.setVisible(false);
    const capture = await e.sender.capturePage();
    return capture.toDataURL();
  });
  ipcMain.handle("comment:get", (e) => (fromToolbar(e) || fromPage(e) ? commentMode : null));
  ipcMain.on("comment:mode", (e, on: unknown) => {
    if (fromToolbar(e) || fromPage(e)) setCommentMode(on === true);
  });
  // The toolbar's mic ↔ the chat sidebar, which owns the microphone. Holding it is push-to-talk, like Shift in the page.
  let micState: unknown = null;
  ipcMain.handle("mic:get", (e) => (fromToolbar(e) ? micState : null));
  ipcMain.on("mic:state", (e, state: unknown) => {
    if (!fromSidebar(e)) return;
    micState = state;
    toolbar?.webContents.send("mic:state", state);
  });
  ipcMain.on("mic:level", (e, rms: unknown) => {
    if (fromSidebar(e) && typeof rms === "number") toolbar?.webContents.send("mic:level", rms);
  });
  ipcMain.on("mic:cmd", (e, cmd: unknown) => {
    if (fromToolbar(e)) sidebar?.webContents.send("mic:cmd", cmd);
  });
  ipcMain.on("mic:ptt", (e, down: unknown) => {
    if (fromToolbar(e)) sidebar?.webContents.send("ptt", down === true);
  });
  ipcMain.on("page:comment", (e, action: unknown) => {
    if (fromPage(e)) sidebar?.webContents.send("page:comment", action);
  });
  ipcMain.handle("page:history-state", (e) =>
    (fromPage(e) && browser ? { ...historyState(browser.webContents), swipedAgo: Date.now() - lastSwipeNav } : null));
  ipcMain.on("page:history", (e, dir: unknown, via: unknown) => { if (fromPage(e)) goHistory(dir, via); });
  ipcMain.on("history:debug", (_e, line: unknown) => historyDebug(`page ${String(line)}`)); // DEBUG-HISTORY
  ipcMain.on("page:navigate", (e, url: unknown) => {
    if (fromSidebar(e) && typeof url === "string" && /^(https?|file):/i.test(url)) currentPage()?.loadURL(url);
  });
}

/** App menu → Uninstall: confirm, then quit and delete the app, its models and its settings (electron/uninstall.ts). */
async function uninstall() {
  const bundle = app.isPackaged ? bundlePath(process.execPath) : null;
  const userData = app.getPath("userData");
  const speechRoot = SPEECH_DIR;
  const paths = uninstallPaths({
    home: homedir(), userData, root: ROOT, speechRoot, exe: process.execPath,
    packaged: app.isPackaged, tmp: tmpdir(), bundleId: bundle ? readBundleId(bundle) : null,
  });
  const parent = win && !win.isDestroyed() ? win : undefined;
  const opts = {
    type: "warning" as const,
    buttons: ["Uninstall", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Uninstall ${APP_NAME}?`,
    detail:
      "The app quits and deletes, permanently:\n\n" + paths.map((p) => `• ${tildify(p)}`).join("\n") +
      `\n• the Keychain entry "${keychainService(app.name).service}" (it encrypts your API keys)` +
      "\n\nThat's the app, the downloaded speech models, your API keys and settings, and the browser pane's sign-ins." +
      (bundle ? "" : `\n\nRunning from the source folder (${tildify(ROOT)}): that folder stays.`) +
      "\nHomebrew tools (whisperkit-cli) stay: other apps can use them.",
  };
  const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  if (response !== 0) return;
  // A detached shell deletes them once this process has exited (the server and the windows have let go of them),
  // then the Keychain entry that encrypts the API keys (deleting needs no permission; reading it would).
  const { service, account } = keychainService(app.name);
  spawn("/bin/sh", ["-c", 'while kill -0 "$0" 2>/dev/null; do sleep 0.2; done; rm -rf -- "$@"; security delete-generic-password -s "$KC_SERVICE" -a "$KC_ACCOUNT" >/dev/null 2>&1', String(process.pid), ...paths], {
    detached: true, stdio: "ignore", env: { ...process.env, KC_SERVICE: service, KC_ACCOUNT: account },
  }).unref();
  void quitNow();
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { label: `Uninstall ${APP_NAME}…`, click: () => void uninstall() },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    // File → Close Window (Cmd-W) closes the focused window. Closing the main window hides it on macOS, or asks to quit elsewhere.
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Address Bar", accelerator: "CmdOrCtrl+L", click: () => toolbar?.webContents.send("focus-address") },
        { label: "Choose Project Folder…", accelerator: "CmdOrCtrl+O", click: () => void pickProjectFolder() },
        { label: "Project Instructions…", click: () => openSettings("instructions") },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => openSettings() },
        { type: "separator" },
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => currentPage()?.reload() },
        { label: "Toggle Inspector", accelerator: "CmdOrCtrl+Alt+I", click: toggleInspector },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ]));
}

function fail(err: unknown) {
  console.error(err);
  app.quit();
}

// The chat turns on the mic and audio at load, without a click first (the sidebar's mic permission is granted below).
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

app.whenReady().then(() => instanceReady).then(() => {
  // Opened from Finder, the PATH lacks the user's tools (the harness CLIs, node, uv, Homebrew): take the login shell's.
  if (app.isPackaged) process.env.PATH = mergePath(loginShellPath(), process.env.PATH ?? "");
  setHotkeys(jsonObject(readSettings().chat).hotkeys);
  registerIpc();
  buildMenu();
  applyEnv(storedEnv().values);
  projectFolder = loadProjectFolder();
  const saved = readSettings().sidebarWidth;
  if (typeof saved === "number" && Number.isFinite(saved)) sidebarWidth = saved;
  sidebarHidden = readSettings().sidebarHidden === true;
  createWindow();
  void webAppBase().catch(fail);
}).catch(fail);

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => {
  if (quitState === "background") return leaveBackground();
  showMainWindow();
});
// Quit (Cmd-Q, the menu, the Dock): asks first while something works (quitting, below).
app.on("before-quit", (e) => {
  if (quitState === "now") return;
  e.preventDefault();
  void requestQuit();
});
app.on("will-quit", () => {
  server?.kill();
  void vite?.close();
  webServer?.close();
});

// ── quitting: ask while work is running; finish it in the background; one app at a time ──
// The server reports what's working (server/activity.ts): element-thread runs, background jobs and conversation
// turns. Quitting while any is asks: finish in the background (the windows and the Dock icon go away, a menu-bar
// item shows what's left, a notification as each one ends, and the app quits after the last), stop and quit, or
// cancel. Either way the thread list is saved (server/threads/persist.ts): a thread that was stopped mid-run comes
// back interrupted, with Resume. In dev, `npm run app` again asks the running one to quit (the same question) and
// starts once it has: the new code takes over without two apps sharing the same files.

/** none: running normally. background: finishing work after Quit, then quitting. now: quitting for real. */
let quitState: "none" | "background" | "now" = "none";
/** Titles of what the server is working on (its `activity` messages). */
let runningTasks: string[] = [];
let tray: Tray | null = null;
/** A quit question is showing (repeated requests don't stack another). */
let quitPrompt = false;
/** A new dev instance is waiting for this one to quit (`npm run app` again). */
let relaunchWaiting = false;
/** The waiting dev instance gives up when this file appears (the user kept the running one). */
const relaunchCancelFile = () => join(app.getPath("userData"), "relaunch-cancelled");

function onServerMessage(msg: {
  type: string;
  running?: string[];
  finished?: { title: string; outcome: "done" | "failed" | "stopped" };
  status?: ChangesStatus;
  changesRequest?: number;
}): void {
  if (msg.type === "changes-status" && msg.status && msg.changesRequest === changesProjectRequest) setChangesStatus(msg.status);
  if (msg.type !== "activity" || !Array.isArray(msg.running)) return;
  runningTasks = msg.running;
  const f = msg.finished;
  const hidden = quitState === "background" || !win || win.isDestroyed() || !win.isVisible();
  if (f && f.outcome !== "stopped" && hidden && Notification.isSupported()) {
    new Notification({ title: f.outcome === "done" ? `${f.title}: done` : `${f.title}: failed`, body: quitState === "background" ? remainingText() : "" }).show();
  }
  if (quitState !== "background") return;
  if (!runningTasks.length) {
    if (Notification.isSupported()) new Notification({ title: `${APP_NAME} finished its work and quit` }).show();
    void quitNow();
  } else updateTray();
}

const tasksText = (n: number) => `${n} task${n === 1 ? "" : "s"}`;
const remainingText = () => runningTasks.length ? `${tasksText(runningTasks.length)} still working.` : "";
const taskList = () => runningTasks.slice(0, 6).map((t) => `• ${t}`).join("\n") + (runningTasks.length > 6 ? `\n• and ${runningTasks.length - 6} more` : "");

function showMainWindow(): void {
  if (!win || win.isDestroyed()) createWindow();
  else win.show();
}

/** Quit, or ask first while something is working. `relaunch`: a new dev instance asked (it starts once this quits). */
async function requestQuit(relaunch = false): Promise<void> {
  if (quitState === "now" || quitPrompt) return;
  if (quitState === "background") { if (!runningTasks.length) void quitNow(); return; }
  if (!runningTasks.length) return void quitNow();
  quitPrompt = true;
  const parent = win && !win.isDestroyed() && win.isVisible() ? win : undefined;
  const opts = {
    type: "question" as const,
    buttons: relaunch ? ["Finish, Then Restart", "Stop and Restart", "Keep Running"] : ["Finish in Background", "Stop and Quit", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    message: `${tasksText(runningTasks.length)} still working`,
    detail: `${taskList()}\n\n` + (relaunch
      ? "A new Vizzo is starting. It can wait for these to finish, or stop them now."
      : "Finish in Background closes the window and quits once they're done. Stop and Quit stops them now.") +
      " Either way your threads are kept: a stopped one comes back with Resume.",
  };
  if (relaunch) app.focus({ steal: true });
  try {
    const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
    if (response === 0) enterBackground();
    else if (response === 1) await quitNow();
    else if (relaunch) {
      relaunchWaiting = false;
      try { writeFileSync(relaunchCancelFile(), String(Date.now())); } catch (err) { console.error(err); }
    }
  } finally {
    quitPrompt = false;
  }
}

/** Save the threads (the server writes what's pending), then quit for real. */
async function quitNow(): Promise<void> {
  if (quitState === "now") return;
  quitState = "now";
  tray?.destroy();
  tray = null;
  const s = server;
  if (s) {
    await new Promise<void>((resolve) => {
      const done = (msg: { type: string }) => { if (msg.type === "flushed") finish(); };
      const timer = setTimeout(() => finish(), 1500);
      const finish = () => { clearTimeout(timer); s.off("message", done); resolve(); };
      s.on("message", done);
      try { s.postMessage({ type: "flush" }); } catch { finish(); }
    });
  }
  app.quit();
}

/** Finish in the background: no windows, no Dock icon, sound off; a menu-bar item until the last task is done. */
function enterBackground(): void {
  quitState = "background";
  for (const w of BrowserWindow.getAllWindows()) w.hide();
  sidebar?.webContents.setAudioMuted(true);
  browser?.webContents.setAudioMuted(true);
  app.dock?.hide();
  tray = new Tray(nativeImage.createEmpty());
  updateTray();
  console.log(`[app] finishing ${tasksText(runningTasks.length)} in the background, then quitting`);
}

/** Back from the background (the menu-bar item, the Dock, or opening the app again): Quit is cancelled. */
function leaveBackground(): void {
  if (quitState !== "background") return;
  quitState = "none";
  tray?.destroy();
  tray = null;
  sidebar?.webContents.setAudioMuted(false);
  browser?.webContents.setAudioMuted(false);
  void app.dock?.show();
  showMainWindow();
}

function updateTray(): void {
  if (!tray) return;
  tray.setTitle(`${APP_NAME} · ${tasksText(runningTasks.length)}`);
  tray.setToolTip(`${APP_NAME} is finishing ${tasksText(runningTasks.length)}, then quits`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Finishing ${tasksText(runningTasks.length)}, then quitting`, enabled: false },
    ...runningTasks.slice(0, 8).map((t) => ({ label: t, enabled: false })),
    { type: "separator" },
    { label: `Show ${APP_NAME}`, click: leaveBackground },
    { label: relaunchWaiting ? "Stop Them and Restart Now" : "Stop Them and Quit Now", click: () => void quitNow() },
  ]));
}

app.on("second-instance", (_e, _argv, _cwd, data) => {
  const relaunch = !app.isPackaged && (data as { relaunch?: unknown } | null)?.relaunch === true;
  if (!relaunch) {
    // Opened again: the running app comes forward (out of the background, if it was finishing there).
    if (quitState === "background") leaveBackground();
    else showMainWindow();
    return;
  }
  // `npm run app` again: the waiting instance pings until this one is gone.
  if (relaunchWaiting && (quitState === "background" || quitPrompt)) return;
  relaunchWaiting = true;
  if (quitState === "background") { updateTray(); return; }
  console.log("[app] a new instance is starting: quitting this one");
  void requestQuit(true);
});

/**
 * One app at a time (they'd share the thread list and the settings). In dev, a second `npm run app` waits for the
 * running one to quit (it's asked, above) and then starts; packaged, opening it again brings the running one forward.
 */
function singleInstance(): Promise<void> {
  if (app.requestSingleInstanceLock({ relaunch: true })) return Promise.resolve();
  if (app.isPackaged) { app.exit(0); return new Promise(() => {}); }
  console.log("[app] another Vizzo (dev) is running: asking it to quit, then starting…");
  const started = Date.now();
  rmSync(relaunchCancelFile(), { force: true });
  return new Promise((resolve) => {
    let said = false;
    const timer = setInterval(() => {
      if (existsSync(relaunchCancelFile())) {
        clearInterval(timer);
        rmSync(relaunchCancelFile(), { force: true });
        console.log("[app] the running Vizzo was kept: not starting another");
        app.exit(0);
        return;
      }
      if (app.requestSingleInstanceLock({ relaunch: true })) { clearInterval(timer); resolve(); return; }
      if (!said && Date.now() - started > 5000) { said = true; console.log("[app] waiting for the running Vizzo to finish its tasks (its menu-bar item shows what's left)…"); }
    }, 1000);
  });
}
const instanceReady = singleInstance();
// Ctrl-C in the `npm run app` terminal (or a kill): save the threads and quit now, no question.
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void quitNow());
