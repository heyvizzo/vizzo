// Exposes the toolbar's controls to shell/index.html, the divider's drags to shell/divider.html, and the browser
// pane (push-to-talk, pointer samples, clicks, highlights, the overlay; web/cursor/pageBridge.ts) to the chat sidebar.
// Nothing else from Node or Electron reaches the page.
import { contextBridge, ipcRenderer } from "electron";
import { isPttKey, isTypingTarget } from "../web/audio/ptt.ts";
// Hover tooltips here are Chromium's own `title` tooltips; the custom ones (tooltip.ts) are only for the browser pane.

contextBridge.exposeInMainWorld("shell", {
  go: (input: string) => ipcRenderer.invoke("nav:go", input),
  back: () => ipcRenderer.invoke("nav:back"),
  forward: () => ipcRenderer.invoke("nav:forward"),
  reload: () => ipcRenderer.invoke("nav:reload"),
  stop: () => ipcRenderer.invoke("nav:stop"),
  getProject: () => ipcRenderer.invoke("project:get"),
  /** Settings: import cookies from Chrome, Safari, or Firefox into the browser pane. */
  importCookies: (browser: string) => ipcRenderer.invoke("cookies:import", browser),
  /** Settings: delete every cookie in the browser pane (Chrome, Safari, Firefox are untouched). */
  clearCookies: () => ipcRenderer.invoke("cookies:clear"),
  onProject: (cb: (dir: string | null) => void) => {
    ipcRenderer.on("project-changed", (_e, dir: unknown) => cb(typeof dir === "string" ? dir : null));
  },
  /** The button right of the address bar (shell/folder.html) shows and hides the chat sidebar. */
  toggleSidebar: () => ipcRenderer.send("sidebar:toggle"),
  onSidebarHidden: (cb: (hidden: boolean) => void) => ipcRenderer.on("sidebar-hidden", (_e, hidden) => cb(hidden === true)),
  /** The pane divider (shell/divider.html): a drag starts / ends (main follows the cursor in between). */
  divider: (phase: "start" | "end") => ipcRenderer.send("divider", phase),
  /** The tooltip view (shell/tooltip.html): lays out the text main.ts sends and reports its size. */
  tooltip: {
    onText: (cb: (id: number, text: string) => void) => ipcRenderer.on("tooltip:text", (_e, id, text) => cb(id, text)),
    size: (id: number, width: number, height: number) => ipcRenderer.send("tooltip:size", id, width, height),
  },
  pickProject: () => ipcRenderer.invoke("project:pick"),
  openSettings: () => ipcRenderer.invoke("settings:open"),
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (values: unknown) => ipcRenderer.invoke("settings:save", values),
    refresh: () => ipcRenderer.invoke("settings:refresh"),
    allowMicrophone: () => ipcRenderer.invoke("settings:allow-microphone"),
    allowKeychain: () => ipcRenderer.invoke("settings:allow-keychain"),
    openPrivacy: (pane: string) => ipcRenderer.invoke("settings:open-privacy", pane),
  },
  onState: (cb: (state: unknown) => void) => ipcRenderer.on("nav-state", (_e, state) => cb(state)),
  onFocusAddress: (cb: () => void) => ipcRenderer.on("focus-address", () => cb()),
  onPtt: (cb: (down: boolean) => void) => ipcRenderer.on("ptt", (_e, down) => cb(down === true)),
  /** Esc in the browser pane or the toolbar (main relays it): stop speaking, and a burst of three asks to stop its task. */
  onEscape: (cb: () => void) => ipcRenderer.on("escape", () => cb()),
  /**
   * The top bars (shell/index.html, folder.html): Shift is push-to-talk there too, except in the address field. A
   * clicked button would otherwise keep the keyboard, so it lets go on Shift, and main gives the keyboard to the sidebar
   * on release.
   */
  bindShiftPtt: () => {
    let held = false;
    const ptt = (down: boolean) => {
      if (held === down) return;
      held = down;
      ipcRenderer.send("bar:ptt", down);
    };
    window.addEventListener("keydown", (e) => {
      if (e.repeat || !isPttKey(e) || isTypingTarget(e.target)) return;
      (document.activeElement as HTMLElement | null)?.blur();
      ptt(true);
    }, true);
    window.addEventListener("keyup", (e) => { if (e.key === "Shift") ptt(false); }, true);
    window.addEventListener("blur", () => ptt(false));
  },
  /**
   * Feedback queue. The toolbar (shell/index.html) shows the Instant toggle and the Send button; the chat sidebar holds
   * the queued turns (web/chat/main.ts). main.ts relays between them and keeps the last state for a reloaded toolbar.
   */
  queue: {
    getState: () => ipcRenderer.invoke("queue:get"),
    onState: (cb: (state: unknown) => void) => ipcRenderer.on("queue:state", (_e, state) => cb(state)),
    setInstant: (on: boolean) => ipcRenderer.send("queue:cmd", { type: "instant", on }),
    send: () => ipcRenderer.send("queue:cmd", { type: "send" }),
    publish: (state: unknown) => ipcRenderer.send("queue:state", state),
    onCmd: (cb: (cmd: unknown) => void) => ipcRenderer.on("queue:cmd", (_e, cmd) => cb(cmd)),
  },
  /**
   * The toolbar's mic (shell/index.html): mirrors the sidebar's talk button and Always listen box, and draws the level
   * while Always listen is on. Holding it is push-to-talk (main relays it to the sidebar as "ptt").
   */
  mic: {
    getState: () => ipcRenderer.invoke("mic:get"),
    onState: (cb: (state: unknown) => void) => ipcRenderer.on("mic:state", (_e, state) => cb(state)),
    onLevel: (cb: (rms: number) => void) => ipcRenderer.on("mic:level", (_e, rms) => cb(typeof rms === "number" ? rms : 0)),
    setAlways: (on: boolean) => ipcRenderer.send("mic:cmd", { type: "always", on }),
    ptt: (down: boolean) => ipcRenderer.send("mic:ptt", down),
    publish: (state: unknown) => ipcRenderer.send("mic:state", state),
    level: (rms: number) => ipcRenderer.send("mic:level", rms),
    onCmd: (cb: (cmd: unknown) => void) => ipcRenderer.on("mic:cmd", (_e, cmd) => cb(cmd)),
  },
  /**
   * The chat's settings JSON, kept in the app's settings file across launches. The sidebar and the Settings window
   * each save the keys they change (merged in main); the sidebar hears what Settings changed.
   */
  chatSettings: {
    get: (): string | null => ipcRenderer.sendSync("chat-settings:get"),
    save: (json: string) => ipcRenderer.send("chat-settings:save", json),
    onChanged: (cb: (json: string) => void) => ipcRenderer.on("chat-settings:changed", (_e, json) => { if (typeof json === "string") cb(json); }),
  },
  /** Comment mode (the toolbar's pointer button): main keeps it and tells the toolbar and the browser pane. */
  comment: {
    get: () => ipcRenderer.invoke("comment:get"),
    set: (on: boolean) => ipcRenderer.send("comment:mode", on),
    onState: (cb: (on: boolean) => void) => ipcRenderer.on("comment:state", (_e, on) => cb(on === true)),
  },
  page: {
    send: (cmd: unknown) => ipcRenderer.send("page:cmd", cmd),
    onSamples: (cb: (samples: unknown) => void) => ipcRenderer.on("page:samples", (_e, samples) => cb(samples)),
    onEvents: (cb: (msg: unknown) => void) => ipcRenderer.on("page:events", (_e, msg) => cb(msg)),
    // Element threads: the pane's URL (filters which threads it shows), opening a thread, the page's thread actions.
    getUrl: () => ipcRenderer.invoke("page:url"),
    onUrl: (cb: (url: unknown) => void) => ipcRenderer.on("page:url", (_e, url) => cb(url)),
    navigate: (url: string) => ipcRenderer.send("page:navigate", url),
    openThread: (threadId: string) => ipcRenderer.send("page:open-thread", threadId),
    onThreadAction: (cb: (action: unknown) => void) => ipcRenderer.on("page:thread", (_e, action) => cb(action)),
    // Comment mode: the bubble's actions (open / record / send).
    onComment: (cb: (action: unknown) => void) => ipcRenderer.on("page:comment", (_e, action) => cb(action)),
  },
});
