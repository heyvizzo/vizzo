import { WebContentsView, type BaseWindow, type Rectangle, type WebContents } from "electron";
import { join } from "node:path";
import type { CursorSample } from "../shared/protocol.ts";
import { normalizePageUrl } from "../shared/threads.ts";
import type { PageChangesStatus, PageCmd, PageCommentAction, PageThreadAction, PageHeldAction } from "../web/cursor/pageBridge.ts";
import type { MarkerGeometry } from "../web/cursor/threadLayout.ts";

export interface PanelLocation { id: string; token: number; geometry: MarkerGeometry; sample?: CursorSample }

/** A sibling of the inspected page. Only an explicit open/close or navigation to a different page changes its lifetime. */
export function installThreadPanel(win: BaseWindow, page: WebContents, paneBounds: () => Rectangle, bundle: string,
  sidebar: (channel: string, ...args: unknown[]) => void, openThreadChanges: (threadId: string) => void) {
  const view = new WebContentsView({ webPreferences: {
    preload: join(bundle, "panel-preload.cjs"), sandbox: true, contextIsolation: true, backgroundThrottling: false,
    partition: "vizzo-thread-panel",
  } });
  view.setBackgroundColor("#00000000");
  view.setVisible(false);
  win.contentView.addChildView(view);
  const wc = view.webContents;
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", event => event.preventDefault());
  let documentId = "", pageUrl = "", sequence = 0;
  let active: PanelLocation | null = null;
  let ready = false, drawing = false, preview = false, focusOnShow = false;
  let rect: Rectangle | null = null;
  const latest = new Map<PageCmd["type"], PageCmd>();
  let changes: { status: PageChangesStatus; enabled: boolean } = { status: null, enabled: false };
  const track = () => { if (!page.isDestroyed()) page.send("panel:track", active?.id ?? null); };
  const show = () => { if (ready && active) wc.send("panel:show", active); };
  function layout() {
    if (!active || !rect || drawing) { view.setVisible(false); return; }
    const pane = paneBounds();
    const zoom = page.getZoomFactor();
    if (wc.getZoomFactor() !== zoom) wc.setZoomFactor(zoom);
    const vw = Math.round(pane.width / zoom), vh = Math.round(pane.height / zoom);
    if (ready && (Math.abs(active.geometry.vw - vw) > 1 || Math.abs(active.geometry.vh - vh) > 1)) {
      active.geometry = { ...active.geometry, vw, vh };
      wc.send("panel:anchor", active.token, active.geometry);
    }
    const width = Math.min(pane.width, Math.ceil(rect.width * zoom));
    const height = Math.min(pane.height, Math.ceil(rect.height * zoom));
    const x = Math.min(pane.width - width, Math.max(0, Math.round(rect.x * zoom)));
    const y = Math.min(pane.height - height, Math.max(0, Math.round(rect.y * zoom)));
    view.setBounds(preview ? pane : { x: pane.x + x, y: pane.y + y, width, height });
    if (!view.getVisible()) view.setVisible(true);
    if (focusOnShow) { focusOnShow = false; wc.focus(); }
  }
  function close() {
    if (!active) return;
    const token = active.token;
    active = null;
    rect = null;
    preview = focusOnShow = false;
    const focused = wc.isFocused();
    view.setVisible(false);
    if (focused && !page.isDestroyed()) page.focus();
    if (ready) wc.send("panel:hide", token);
    track();
    sidebar("page:thread", { type: "thread.panel", threadId: null });
  }
  function navigation() {
    const next = normalizePageUrl(page.getURL());
    if (pageUrl !== next) close();
    pageUrl = next;
  }
  page.on("did-navigate", navigation);
  page.on("did-navigate-in-page", (_event, _url, mainFrame) => { if (mainFrame) navigation(); });
  page.ipc.on("page:ready", (event, doc: string) => {
    if (event.senderFrame !== page.mainFrame) return;
    documentId = doc;
    navigation();
    track();
  });
  page.ipc.on("panel:open", (event, doc: string, id: string, geometry: MarkerGeometry, sample?: CursorSample) => {
    if (event.senderFrame !== page.mainFrame || doc !== documentId) return;
    const list = latest.get("threads");
    if (list?.type !== "threads" || !list.threads.some(t => t.threadId === id && t.pageUrl === pageUrl)) return;
    if (active?.id === id) { wc.focus(); return; }
    preview = false;
    active = { id, geometry, sample, token: ++sequence };
    focusOnShow = true;
    track();
    sidebar("page:thread", { type: "thread.panel", threadId: id });
    show();
  });
  page.ipc.on("panel:anchor", (_e, doc: string, id: string, geometry: MarkerGeometry) => {
    if (doc !== documentId || active?.id !== id) return;
    // While a framework remounts its DOM, retain the last live anchor.
    if (!geometry.resolved) geometry = { ...geometry, x: active.geometry.x, y: active.geometry.y };
    active.geometry = geometry;
    if (ready) wc.send("panel:anchor", active.token, geometry);
    if (page.getZoomFactor() !== wc.getZoomFactor()) layout();
  });
  page.ipc.on("panel:dismiss", (_e, doc: string, id: string) => { if (doc === documentId && active?.id === id) close(); });
  page.ipc.on("panel:outside", (_e, doc: string, id: string) => {
    if (ready && doc === documentId && active?.id === id) wc.send("panel:outside", active.token);
  });
  wc.ipc.on("panel:ready", () => {
    ready = true;
    wc.send("changes:page-status", changes.status, changes.enabled);
    for (const cmd of latest.values()) wc.send("panel:cmd", cmd);
    show();
  });
  wc.ipc.on("panel:bounds", (_e, token: number, next: Rectangle) => {
    if (active?.token !== token || ![next.x, next.y, next.width, next.height].every(Number.isFinite)) return;
    rect = next;
    layout();
  });
  wc.ipc.on("panel:close", (_e, token: number) => { if (active?.token === token) close(); });
  wc.ipc.on("panel:preview", (_e, token: number, on: boolean) => {
    if (active?.token === token) { preview = on; layout(); }
  });
  wc.ipc.on("panel:thread", (event, token: number, action: PageThreadAction | PageHeldAction) => {
    if (!active || active.token !== token || event.senderFrame !== wc.mainFrame || !action || typeof action !== "object") return;
    if ("threadId" in action && action.threadId !== active.id) return;
    if (action.type === "thread.commit") openThreadChanges(active.id);
    else sidebar("page:thread", action);
  });
  wc.ipc.on("panel:comment", (_e, token: number | undefined, action: PageCommentAction) => {
    // Closing the previous editor must still release its draft and its microphone.
    const cleanup = (action.type === "comment.draft" && !action.open) || (action.type === "comment.record" && !action.on);
    if (cleanup || (active && active.token === token)) sidebar("page:comment", action, "panel");
  });
  wc.ipc.on("panel:ptt", (_e, token: number | undefined, down: boolean) => {
    if (!down || (active && active.token === token)) sidebar("ptt", down);
  });
  win.once("closed", () => { if (!wc.isDestroyed()) wc.close(); });
  void wc.loadFile(join(bundle, "shell", "thread-panel.html"));
  return {
    view, layout, previewOpen: () => preview,
    setChangesStatus(status: PageChangesStatus, enabled: boolean) {
      changes = { status, enabled };
      if (ready) wc.send("changes:page-status", status, enabled);
    },
    drawing(on: boolean) { drawing = on; layout(); },
    command(cmd: PageCmd) {
      if (cmd.type === "thread.delete.preview") {
        if (ready && active?.id === cmd.threadId) wc.send("panel:cmd", cmd);
        return;
      }
      if (cmd.type !== "threads" && cmd.type !== "held" && cmd.type !== "debug" && !("surface" in cmd && cmd.surface === "panel")) return;
      if (cmd.type !== "comment.insert") latest.set(cmd.type, cmd);
      if (cmd.type === "threads" && active && !cmd.loading && !cmd.threads.some(t => t.threadId === active!.id)) close();
      if (ready) wc.send("panel:cmd", cmd);
    },
  };
}
