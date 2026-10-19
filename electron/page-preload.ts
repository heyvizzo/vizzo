// Preload for the browser pane (the pages the user visits). The page runs in its own process, so everything the chat
// needs from it is captured here and relayed by main.ts to the sidebar (web/cursor/pageBridge.ts):
// - push-to-talk: Shift held on the page (not while typing) → ptt(true/false);
// - pointer samples (~60 Hz, sent in batches) and the turn's clicks and highlights, recorded between start and stop;
// - the turn's pointing targets and cursor rests, drawn over the page;
// - element threads: markers, the thread panel, bubbles and the provisional marker, and the conversation orb
//   (web/cursor/threadOverlay.ts);
// - comment mode: click an element, type or dictate feedback in a bubble on it (web/cursor/commentOverlay.ts); the
//   bubble and the thread panel share an inline form whose dictation the chat runs (web/cursor/inlineForm.ts).
// Nothing is exposed to the page: this runs in the preload's isolated world, with capture-phase listeners that run
// before the page's own. The overlay lives in a closed shadow root, so the page's CSS can't touch it.
import { ipcRenderer, webFrame } from "electron";
import type { CursorSample, ReactInfo } from "../shared/protocol.ts";
import { isPttKey, isTypingTarget } from "../web/audio/ptt.ts";
import { createPageContextRecorder } from "../web/cursor/pageContext.ts";
import { findPath, renderOverlay } from "../web/cursor/overlay.ts";
import { reactInfo } from "../web/cursor/reactInfo.ts";
import { Sampler } from "../web/cursor/sampler.ts";
import { shiftPageEvents, shiftSamples, type PageCmd, type PageCommentAction, type PageConfirmAction, type PageEventsMsg, type PageOrbAction, type PagePanelAction, type PageThreadAction } from "../web/cursor/pageBridge.ts";
import { UI_THEME_CSS } from "../web/cursor/colors.ts";
import { THREAD_CSS, createThreadOverlay } from "../web/cursor/threadOverlay.ts";
import { COMMENT_CSS, createCommentOverlay } from "../web/cursor/commentOverlay.ts";
import { INLINE_FORM_CSS, createFormHub, type FormHub } from "../web/cursor/inlineForm.ts";
import { installTooltips } from "./tooltip.ts";

const SAMPLE_BATCH_MS = 100;
/** React info for an element is fetched again after this long (the page may have re-rendered it). */
const REACT_INFO_TTL_MS = 2000;
/** Page clock → epoch ms. */
const ORIGIN = performance.timeOrigin;
/** This document; a turn's events can come from several (a click on a link navigates mid-turn). */
const DOC = `${ORIGIN}-${Math.random().toString(36).slice(2)}`;

const OVERLAY_CSS = `
.layer { position: absolute; left: 0; top: 0; width: 0; height: 0; }
.ov-box { position: absolute; border: 2px solid; border-radius: 4px; box-sizing: border-box; }
.ov-tag { position: absolute; left: -2px; top: -16px; font: 10px/14px ui-monospace, monospace; padding: 0 4px; border-radius: 3px; white-space: nowrap; }
.ov-dot { position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px #000; box-sizing: border-box; }`;

// ── push-to-talk ──

let held = false;
const ptt = (down: boolean) => {
  if (held === down) return;
  held = down;
  ipcRenderer.send("ptt", down);
};
/** Set in init(). The bubbles' fields are inside the closed shadow root, so isTypingTarget can't see them: ask. */
let forms: FormHub | null = null;
window.addEventListener("keydown", (e) => {
  if (!e.repeat && isPttKey(e) && !isTypingTarget(e.target) && !forms?.typing()) ptt(true);
}, true);
window.addEventListener("keyup", (e) => {
  if (e.key === "Shift") ptt(false);
}, true);
window.addEventListener("blur", () => ptt(false));
window.addEventListener("pagehide", () => ptt(false));

// ── recording and overlay (once the document exists) ──

function init(): void {
  const root = document.documentElement;
  const scroller = (document.scrollingElement ?? root) as HTMLElement;

  let batch: CursorSample[] = [];
  const flushSamples = () => {
    if (!batch.length) return;
    ipcRenderer.send("page:samples", shiftSamples(batch, ORIGIN));
    batch = [];
  };
  const sampler = new Sampler(root, scroller);
  sampler.onSample = (s) => batch.push(s);
  // React component info lives in the page's own JavaScript world: fetch it there (async), cache it per element, and
  // have the sampler take the element's details again once it arrives.
  const react = new Map<string, { at: number; info: ReactInfo | null; pending: boolean }>();
  sampler.decorate = (details, path) => {
    const hit = react.get(path);
    if (hit?.info) details.react = hit.info;
    if (hit && (hit.pending || performance.now() - hit.at < REACT_INFO_TTL_MS)) return;
    react.set(path, { at: performance.now(), info: hit?.info ?? null, pending: true });
    if (react.size > 500) react.delete(react.keys().next().value!);
    webFrame.executeJavaScript(`(${reactInfo.toString()})(document.querySelector(${JSON.stringify(path)}))`)
      .then((info: ReactInfo | null) => {
        react.set(path, { at: performance.now(), info: info ?? null, pending: false });
        if (info && JSON.stringify(info) !== JSON.stringify(hit?.info)) sampler.refreshDetails();
      })
      .catch(() => react.set(path, { at: performance.now(), info: null, pending: false }));
  };
  sampler.start();
  setInterval(flushSamples, SAMPLE_BATCH_MS);
  // Pointer left the pane (e.g. towards the chat's button): stop reporting the last element as pointed at.
  document.addEventListener("mouseout", (e) => { if (!e.relatedTarget) sampler.forget(); }, true);

  const rec = createPageContextRecorder(root);
  let active = false;
  const sendEvents = (final: boolean) => {
    const msg: PageEventsMsg = { doc: DOC, final, events: shiftPageEvents(rec.current(), ORIGIN) };
    ipcRenderer.send("page:events", msg);
  };
  rec.onChange = () => { if (active) sendEvents(false); };
  const start = (tEpoch: number) => {
    active = true;
    rec.start(tEpoch - ORIGIN);
  };

  // Overlay: positioned in document coordinates, so it scrolls with the page. Its own elements are pointer-events:none
  // except the thread markers, panel and bubbles.
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = UI_THEME_CSS + OVERLAY_CSS + THREAD_CSS + COMMENT_CSS + INLINE_FORM_CSS;
  const layer = document.createElement("div");
  layer.className = "layer";
  const threadLayer = document.createElement("div");
  const commentLayer = document.createElement("div");
  shadow.append(style, layer, threadLayer, commentLayer);
  const attach = () => { if (!host.isConnected) root.append(host); };
  // Tooltips for the overlay's buttons and for the page's own `title`s (native ones don't show in this view).
  installTooltips((el, x, y) => (el === host ? shadow.elementFromPoint(x, y) : null));
  /** renderOverlay's scroller: the viewport (rect at 0,0, the window's scroll), so boxes land in document coords. */
  const viewport = () => ({
    getBoundingClientRect: () => new DOMRect(0, 0, innerWidth, innerHeight),
    clientLeft: 0, clientTop: 0, scrollLeft: scrollX, scrollTop: scrollY,
  }) as unknown as HTMLElement;
  let shown: Extract<PageCmd, { type: "overlay" }> | null = null;
  /** The sidebar's debug toggle: pointing outlines are drawn only while it's on. */
  let outlines = false;
  const draw = () => {
    if (!outlines || !shown || (!shown.targets.length && !shown.rests.length)) { layer.replaceChildren(); return; }
    attach();
    renderOverlay(layer, viewport(), shown.targets, [], new Set(shown.visible), null, shown.rests);
  };
  window.addEventListener("resize", draw);

  // The comment bubble's and the thread panel's forms: dictation goes into the active one.
  const hub = createFormHub({
    send: (action: PageCommentAction) => ipcRenderer.send("page:comment", action),
    ptt,
    changed: () => comments.refresh(),
  });
  forms = hub;
  const threads = createThreadOverlay({
    layer: threadLayer,
    host,
    attach,
    pointed: () => findPath([...sampler.samples].reverse().find((s) => s.elementPath)?.elementPath ?? null),
    pointer: () => {
      const s = [...sampler.samples].reverse().find((x) => x.elementPath);
      return s ? { x: s.x + s.scrollX, y: s.y + s.scrollY } : null;
    },
    send: (action: PageThreadAction | PageOrbAction | PagePanelAction | PageConfirmAction) => ipcRenderer.send("page:thread", action),
    sampleAt: (x, y) => sampler.sampleAt(x, y),
    forms: hub,
  });
  const comments = createCommentOverlay({
    layer: commentLayer,
    host,
    attach,
    sampleAt: (x, y) => sampler.sampleAt(x, y),
    forms: hub,
    queuedOn: (domPath) => threads.queuedOn(domPath),
    requestMode: (on) => ipcRenderer.send("comment:mode", on),
  });
  // Pointing at a marker, its bubble or its panel (or a comment bubble) means its element; the orb means nothing (it's
  // the page as a whole); the rest of the overlay is see-through.
  sampler.pick = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (el !== host) return el;
    const inner = shadow.elementFromPoint(x, y);
    if (inner && threads.isOrb(inner)) return null;
    return (inner && (threads.anchorFor(inner) ?? comments.anchorFor(inner))) ?? document.elementsFromPoint(x, y).find((e) => e !== host) ?? null;
  };
  ipcRenderer.on("page:comment-mode", (_e, on: unknown, keepDraft: unknown) => comments.setMode(on === true, keepDraft === true));
  ipcRenderer.on("page:comment-at", (_e, p: { x?: unknown; y?: unknown } | null) => {
    if (typeof p?.x === "number" && typeof p.y === "number") comments.openAt(p.x, p.y);
  });
  void ipcRenderer.invoke("comment:get").then((on: unknown) => comments.setMode(on === true));
  // A new document has no open bubble (the chat may still think one is open from the last page).
  ipcRenderer.send("page:comment", { type: "comment.draft", open: false } satisfies PageCommentAction);
  ipcRenderer.on("page:open-thread", (_e, threadId: unknown) => {
    if (typeof threadId === "string") threads.open(threadId);
  });

  ipcRenderer.on("page:cmd", (_e, cmd: PageCmd) => {
    switch (cmd.type) {
      case "start":
        start(cmd.t);
        break;
      case "stop":
        flushSamples(); // samples first: the chat sends them on as soon as the events arrive
        active = false;
        rec.stop();
        sendEvents(true);
        break;
      case "clear":
        active = false;
        rec.clear();
        break;
      case "overlay":
        shown = cmd;
        draw();
        break;
      case "debug":
        outlines = cmd.outlines;
        draw();
        comments.setAlwaysHover(cmd.hover);
        threads.setDetails(cmd.details);
        break;
      case "threads":
        threads.setThreads(cmd.threads);
        comments.refresh(); // what's queued on its element
        break;
      case "bubble":
        threads.bubble(cmd.say, cmd.ended, cmd.confirm);
        break;
      case "orb":
        threads.setOrb(cmd.state, cmd.pos);
        break;
      case "conversation":
        threads.setConversation(cmd.entries);
        break;
      case "provisional":
        threads.provisional(cmd.turnId);
        break;
      case "provisional.clear":
        threads.clearProvisional(cmd.turnId);
        break;
      case "comment.state":
        hub.update(cmd.state);
        break;
      case "comment.insert":
        hub.insert(cmd.text);
        break;
    }
  });
  // Ready for commands: the chat sends this document its threads.
  ipcRenderer.send("page:ready");

  // Loaded mid-turn (a click navigated): record the rest of the turn here.
  void ipcRenderer.invoke("page:state").then((state: { tFrom: number | null } | null) => {
    if (state?.tFrom != null && !active) start(state.tFrom);
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
else init();
