// Electron app: a browser pane on the left (address bar + the page) and the voice chat as a sidebar on the right.
// The chat UI is served by Vite inside the app (chat.html) — there is no standalone website; the packaged app serves
// the built pages instead (webServer.ts). The voice server runs in a utilityProcess on a free local port and Vite
// (or webServer.ts) proxies /api and /ws to it. The server starts at launch, before a project folder is chosen (its
// agents wait in an empty temp folder until then), and it gets the browser pane's URL with every page change (it goes
// into each turn's context).
import {
  app, BrowserWindow, Menu, WebContentsView, dialog, ipcMain, nativeTheme, safeStorage, screen, shell, systemPreferences, utilityProcess,
  type IpcMainEvent, type IpcMainInvokeEvent, type UtilityProcess, type WebContents,
} from "electron";
import type { ViteDevServer } from "vite";
import { dirname, join } from "node:path";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { CookieReadError, chromeSafeStoragePassword, readBrowserCookies, toElectronCookie, type BrowserId, type ElectronCookie } from "./cookies.ts";
import { applyEnv, ENV_FIELDS, SECRET_KEYS, sanitizeEnv } from "./settings.ts";
import { keychainService, openEnv, sealEnv, type Cipher } from "./secrets.ts";
import { bundlePath, readBundleId, tildify, uninstallPaths } from "./uninstall.ts";
import { startWebServer } from "./webServer.ts";
import { LEGACY_NAMES, legacySecrets, moveLegacyDir } from "./rename.ts";
import { loginShellPath, mergePath } from "./shellPath.ts";
import { chromeKeychainAccess, fullDiskAccess, fullDiskRow, keychainRow, microphoneRow, type PermissionRow } from "./permissions.ts";
import { THEME } from "../shared/theme.ts";
import { endsHold, fromElectronInput, hotkeys, matchesDown, onHotkeys, setHotkeys } from "../shared/hotkeys.ts";

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
  projectDir?: string; sidebarWidth?: number; sidebarHidden?: boolean; lastUrl?: string;
  /** Where the Settings window was last left (it opens there again). */
  settingsBounds?: { x: number; y: number; width: number; height: number };
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
  mkdirSync(dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), ...patch }, null, 2));
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

/** Settings' sections (web/settings/attention.ts SECTIONS): the one it opens at, named in its URL hash. */
const SETTINGS_SECTIONS = ["dashboard", "models", "stt", "tts", "keyboard", "permissions", "debugging", "cookies", "keys"];

function openSettings(section?: string) {
  const hash = section && SETTINGS_SECTIONS.includes(section) ? `#${section}` : "";
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
        } : {}),
        PORT: String(port),
        PROJECT_DIR: projectFolder ?? "",
      },
      stdio: "inherit",
    });
    server.once("message", (msg: { type: string }) => {
      if (msg.type === "ready") resolve();
    });
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
  toolbar?.webContents.send("nav-state", {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
  });
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
    win = null; toolbar = null; folderBar = null; browser = null; sidebar = null; divider = null; tooltip = null; tooltipPending = null; drag = null;
  });
  win.on("resize", layout);

  const appPrefs = { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true };

  toolbar = new WebContentsView({ webPreferences: appPrefs });
  toolbar.setBackgroundColor("#00000000");
  toolbar.webContents.loadFile(join(__dirname, "shell", "index.html"));
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
    webPreferences: { partition: "persist:browser", preload: join(__dirname, "page-preload.cjs"), contextIsolation: true, sandbox: true },
  });
  browser.webContents.session.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  win.contentView.addChildView(browser);

  // The chat sidebar: the microphone is allowed (voice chat), other permissions are not.
  sidebar = new WebContentsView({ webPreferences: appPrefs });
  sidebar.webContents.session.setPermissionRequestHandler((_wc, permission, done) => done(permission === "media"));
  win.contentView.addChildView(sidebar);

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
  for (const view of [toolbar, sidebar, browser]) view.webContents.on("before-input-event", (_e, input) => commentKey(input));
  // Esc stops the voice wherever focus is (three in a row ask to stop its task too): the sidebar handles its own Esc,
  // the browser pane's and the toolbar's are relayed (the key still reaches the page, so its own Esc works as before).
  for (const view of [toolbar, browser]) {
    view.webContents.on("before-input-event", (_e, input) => {
      if (input.type === "keyDown" && input.key === "Escape" && !input.isAutoRepeat && !drawingPreviewIsOpen) sidebar?.webContents.send("escape");
    });
  }
  // The key can come up in another app: a held mode ends when the window loses focus.
  win.on("blur", () => { if (commentHeld) setCommentMode(false, true); });
  // Back from System Settings (a permission granted): the sidebar checks what still needs attention.
  win.on("focus", attentionChanged);

  const wc = browser.webContents;
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
  projectFolder = dir;
  saveProjectFolder(dir);
  // Started at launch (maybe without a folder, or still starting): it gets the folder once it's listening.
  await startVoiceServer();
  server?.postMessage({ type: "project", dir });
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
      // The required ones only (the Chrome keychain is optional, and checking it runs Swift): cheap, so it's
      // asked again each time the window comes back into focus (after System Settings).
      permissions: [microphoneRow(systemPreferences.getMediaAccessStatus("microphone")), fullDiskRow(fullDiskAccess())],
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
    const view = [toolbar, folderBar, browser, sidebar].find((v) => v?.webContents === e.sender);
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
  ipcMain.on("ptt", (e, down: unknown) => {
    if (fromPage(e)) sidebar?.webContents.send("ptt", down === true);
  });
  for (const channel of ["page:samples", "page:events"]) {
    ipcMain.on(channel, (e, msg: unknown) => {
      if (fromPage(e)) sidebar?.webContents.send(channel, msg);
    });
  }
  ipcMain.on("page:cmd", (e, cmd: { type: string; t?: number }) => {
    if (!sidebar || e.sender !== sidebar.webContents) return;
    if (cmd.type === "start") turnFrom = cmd.t ?? null;
    else if (cmd.type === "stop" || cmd.type === "clear") turnFrom = null;
    browser?.webContents.send("page:cmd", cmd);
  });
  // A page that loads mid-turn asks whether to record.
  ipcMain.handle("page:state", (e) => (fromPage(e) ? { tFrom: turnFrom } : null));
  // Element threads. A document that's ready for commands (load, reload, HMR full reload) gets its threads again.
  const fromSidebar = (e: IpcMainEvent | IpcMainInvokeEvent) => !!sidebar && e.sender === sidebar.webContents;
  ipcMain.on("page:ready", (e) => { if (fromPage(e)) sendPageUrl(); });
  // The chat's settings (read synchronously: the sidebar needs them before it builds its UI). The sidebar and the
  // Settings window each save only the keys they change (web/chat/settings.ts); they're merged here, and the
  // sidebar gets what Settings changed.
  ipcMain.on("chat-settings:get", (e) => { e.returnValue = fromSidebar(e) || fromSettings(e) ? readSettings().chat ?? null : null; });
  ipcMain.on("chat-settings:save", (e, json: unknown) => {
    if (!(fromSidebar(e) || fromSettings(e)) || typeof json !== "string" || json.length >= 200_000) return;
    const merged = JSON.stringify({ ...jsonObject(readSettings().chat), ...jsonObject(json) });
    saveSettings({ chat: merged });
    if (fromSettings(e)) sidebar?.webContents.send("chat-settings:changed", merged);
    setHotkeys(jsonObject(merged).hotkeys);
  });
  // The keyboard shortcuts (shared/hotkeys.ts), saved with the chat's settings: the preloads read them at load and
  // hear each change (the sidebar's page has them from its settings).
  ipcMain.on("hotkeys:get", (e) => { e.returnValue = hotkeys(); });
  onHotkeys((hk) => { for (const view of [toolbar, folderBar, browser, sidebar]) view?.webContents.send("hotkeys", hk); });
  ipcMain.handle("page:url", (e) => (fromSidebar(e) ? browser?.webContents.getURL() || null : null));
  ipcMain.on("page:thread", (e, action: unknown) => {
    if (fromPage(e)) sidebar?.webContents.send("page:thread", action);
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
  app.quit();
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
    // File → Close Window (Cmd-W) closes the focused window: Settings, or the main window (which quits the app).
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Address Bar", accelerator: "CmdOrCtrl+L", click: () => toolbar?.webContents.send("focus-address") },
        { label: "Choose Project Folder…", accelerator: "CmdOrCtrl+O", click: () => void pickProjectFolder() },
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

app.whenReady().then(() => {
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

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  server?.kill();
  void vite?.close();
  webServer?.close();
});
