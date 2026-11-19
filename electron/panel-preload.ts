// The app's thread editor stays mounted while the inspected document reloads.
import { ipcRenderer, webFrame } from "electron";
import { setHotkeys } from "../shared/hotkeys.ts";
import type { ThreadInfo } from "../shared/threads.ts";
import { createTalkKey, isTypingTarget } from "../web/audio/ptt.ts";
import { UI_THEME_CSS } from "../web/cursor/colors.ts";
import { DRAWING_PREVIEW_EVENT, drawingPreviewOpen } from "../web/cursor/drawingPreview.ts";
import { createFormHub, INLINE_FORM_CSS } from "../web/cursor/inlineForm.ts";
import type { PageChangesStatus, PageCmd } from "../web/cursor/pageBridge.ts";
import { THREAD_CSS } from "../web/cursor/threadOverlay.ts";
import { createThreadPanels } from "../web/cursor/threadPanel.ts";
import type { MarkerGeometry } from "../web/cursor/threadLayout.ts";
import type { PanelLocation } from "./threadPanel.ts";
import { installTooltips } from "./tooltip.ts";

setHotkeys(ipcRenderer.sendSync("hotkeys:get"));
ipcRenderer.on("hotkeys", (_e, keys) => setHotkeys(keys));
window.addEventListener("DOMContentLoaded", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = UI_THEME_CSS + THREAD_CSS + INLINE_FORM_CSS;
  const layer = document.createElement("div");
  layer.className = "th-layer";
  shadow.append(style, layer);
  installTooltips((el, x, y) => el === host ? shadow.elementFromPoint(x, y) : null);
  let location: PanelLocation | null = null;
  const threads = new Map<string, ThreadInfo>();
  function ptt(down: boolean) {
    if (down) forms.prepareDictation(true);
    ipcRenderer.send("panel:ptt", location?.token, down);
  }
  const forms = createFormHub({ send: a => ipcRenderer.send("panel:comment", location?.token, a), ptt });
  const talk = createTalkKey(ptt);
  window.addEventListener("keydown", e => talk.keydown(e, !forms.typing() && !isTypingTarget(e.target)), true);
  window.addEventListener("keyup", e => talk.keyup(e), true);
  window.addEventListener("pointerdown", () => talk.pointerdown(), true);
  window.addEventListener("blur", () => talk.release());
  window.addEventListener("focus", () => { if (forms.activeId()) forms.prepareDictation(true); });
  let lastBounds = "";
  let previewOffset = { x: 0, y: 0 };
  const positionLayer = () => {
    layer.style.transform = drawingPreviewOpen() ? `translate(${previewOffset.x}px, ${previewOffset.y}px)` : "";
  };
  const measure = new ResizeObserver(() => panels.position());
  const panels = createThreadPanels({
    layer, forms, thread: id => threads.get(id), orbState: () => "idle",
    queued: path => [...threads.values()].find(t => t.state === "queued" && t.anchor.domPath === path)?.messages ?? [],
    spot: () => location && { ...location.geometry, r: location.geometry.radius, fixed: true },
    submit(id, text) {
      const t = threads.get(id);
      if (!t || location?.id !== id) return false;
      const g = location.geometry;
      // Still usable while the page loads or after an agent removes the element.
      const sample = { ...location.sample, x: g.x, y: g.y, scrollX: g.scrollX, scrollY: g.scrollY,
        t: performance.timeOrigin + performance.now(), elementPath: t.anchor.domPath, dataSource: t.anchor.dataSource, label: t.anchor.label };
      forms.send(text, sample, t.state === "queued" ? undefined : id);
      return true;
    },
    changed() {
      measure.disconnect();
      if (panels.current) measure.observe(panels.current.root);
    },
    send(action) {
      if (!location) return;
      if (action.type === "thread.panel") {
        if (action.threadId === null) ipcRenderer.send("panel:close", location.token);
      } else ipcRenderer.send("panel:thread", location.token, action);
    },
    copyText: text => ipcRenderer.invoke("clipboard:write", text),
    releaseSession: id => ipcRenderer.invoke("session:release", id),
    surface: {
      viewport: () => ({ sx: 0, sy: 0, vw: location?.geometry.vw ?? 1, vh: location?.geometry.vh ?? 1 }),
      zoom: () => webFrame.getZoomFactor(),
      place(rect) {
        if (!location) return;
        previewOffset = rect;
        positionLayer();
        const key = JSON.stringify([location.token, rect]);
        if (key === lastBounds) return;
        lastBounds = key;
        ipcRenderer.send("panel:bounds", location.token, rect);
      },
    },
  });
  ipcRenderer.on("panel:show", (_e, next: PanelLocation) => {
    shadow.querySelector<HTMLDialogElement>("dialog[open]")?.close();
    panels.close();
    location = next;
    layer.dataset.tone = next.geometry.tone;
    panels.open(next.id);
  });
  ipcRenderer.on("panel:hide", (_e, token: number) => {
    if (location?.token !== token) return;
    location = null;
    shadow.querySelector<HTMLDialogElement>("dialog[open]")?.close();
    panels.close();
  });
  ipcRenderer.on("panel:outside", (_e, token: number) => {
    if (location?.token === token && !panels.current?.form?.value().trim() && !forms.state().recording && !forms.state().transcribing) panels.close();
  });
  ipcRenderer.on("panel:anchor", (_e, token: number, g: MarkerGeometry) => {
    if (location?.token !== token) return;
    location.geometry = g;
    layer.dataset.tone = g.tone;
    panels.position();
  });
  ipcRenderer.on("changes:page-status", (_e, status: PageChangesStatus, enabled: boolean) => panels.setChangesStatus(status, enabled));
  ipcRenderer.on("panel:cmd", (_e, cmd: PageCmd) => {
    switch (cmd.type) {
      case "threads":
        panels.setThreadActions(cmd);
        if (!cmd.loading) {
          for (const id of threads.keys()) if (!cmd.threads.some(t => t.threadId === id)) panels.forgetSize(id);
          threads.clear();
        }
        for (const t of cmd.threads) threads.set(t.threadId, t);
        panels.render();
        break;
      case "thread.delete.preview": panels.showDeletePreview(cmd); break;
      case "held": panels.setHeld(cmd.items); break;
      case "debug": panels.setDetails(cmd.details); panels.setSession(cmd.session); panels.setFullAnswers(cmd.fullAnswers); break;
      case "comment.state": forms.update(cmd.state); break;
      case "comment.insert": forms.insert(cmd.text, cmd.dictation); break;
    }
  });
  document.addEventListener(DRAWING_PREVIEW_EVENT, () => {
    positionLayer();
    if (location) ipcRenderer.send("panel:preview", location.token, drawingPreviewOpen());
  });
  ipcRenderer.send("panel:ready");
});
