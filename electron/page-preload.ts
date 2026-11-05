// Preload for the browser pane (the pages the user visits). The page runs in its own process, so everything the chat
// needs from it is captured here and relayed by main.ts to the sidebar (web/cursor/pageBridge.ts):
// - push-to-talk: the talk key (Settings → Keyboard) held on the page (not while typing) → ptt(true/false);
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
import { createTalkKey, isPttKeyUp, isTypingTarget } from "../web/audio/ptt.ts";
import { setHotkeys } from "../shared/hotkeys.ts";
import { createPageContextRecorder } from "../web/cursor/pageContext.ts";
import { findPath, renderOverlay } from "../web/cursor/overlay.ts";
import { reactInfo } from "../web/cursor/reactInfo.ts";
import { Sampler } from "../web/cursor/sampler.ts";
import { shiftPageEvents, shiftSamples, type PageCmd, type PageCommentAction, type PageConfirmAction, type PageEventsMsg, type PageHeldAction, type PageOrbAction, type PagePanelAction, type PageThreadAction } from "../web/cursor/pageBridge.ts";
import { UI_THEME_CSS } from "../web/cursor/colors.ts";
import { THREAD_CSS, createThreadOverlay } from "../web/cursor/threadOverlay.ts";
import { COMMENT_CSS, createCommentOverlay } from "../web/cursor/commentOverlay.ts";
import { INLINE_FORM_CSS, createFormHub, type FormHub } from "../web/cursor/inlineForm.ts";
import { DRAWING_CSS, createDrawingOverlay } from "../web/cursor/drawingOverlay.ts";
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

// Registered before the visited page's scripts: drawing controls must not trigger application handlers.
let drawingInput: ((event: Event) => void) | null = null;
for (const name of ["pointerdown","pointerup","pointermove","pointercancel","mousedown","mouseup","mousemove","click","dblclick","auxclick","contextmenu","wheel","keydown","keyup","beforeinput","input"])
  window.addEventListener(name, e => drawingInput?.(e), { capture: true, passive: false });

// ── push-to-talk ──

// The keyboard shortcuts (Settings → Keyboard): main sends each change.
setHotkeys(ipcRenderer.sendSync("hotkeys:get"));
ipcRenderer.on("hotkeys", (_e, hk: unknown) => setHotkeys(hk));

let held = false;
const ptt = (down: boolean) => {
  if (held === down) return;
  held = down;
  if (down) forms?.prepareDictation();
  ipcRenderer.send("ptt", down);
};
/** Set in init(). The bubbles' fields are inside the closed shadow root, so isTypingTarget can't see them: ask. */
let forms: FormHub | null = null;
const talk = createTalkKey(ptt);
/** Keyboard focus allows the talk key: not in a text control, nor a bubble's field (that handles its own). */
const talkAllowed = (target: EventTarget | null) => !isTypingTarget(target) && !forms?.typing();
const talkUp = () => { forms?.releaseTalkKey(); talk.release(); ptt(false); };
window.addEventListener("keydown", (e) => talk.keydown(e, talkAllowed(e.target)), true);
const talkKeyUp = (e: KeyboardEvent) => { talk.keyup(e); if (isPttKeyUp(e)) forms?.releaseTalkKey(); };
window.addEventListener("keyup", talkKeyUp, true);
window.addEventListener("pointerdown", () => talk.pointerdown(), true);
// On macOS Ctrl-click is a right-click: while Control talks, a click points at the page instead of opening the menu.
window.addEventListener("contextmenu", (e) => { if (held && e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault(); }, true);
window.addEventListener("blur", talkUp);
window.addEventListener("pagehide", talkUp);

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

  // Clip overlay content to the viewport so stale/offscreen anchors cannot enlarge the page.
  // The inner document layer follows scrolling; fixed controls still use the viewport.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;overflow:clip;pointer-events:none;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = UI_THEME_CSS + OVERLAY_CSS + THREAD_CSS + COMMENT_CSS + INLINE_FORM_CSS + DRAWING_CSS;
  const layer = document.createElement("div");
  layer.className = "layer";
  const threadLayer = document.createElement("div");
  const commentLayer = document.createElement("div");
  const drawingLayer = document.createElement("div");
  const documentLayer = document.createElement("div");
  documentLayer.style.cssText = "position:absolute;width:0;height:0;";
  const followScroll = () => {
    documentLayer.style.left = `${-scrollX}px`;
    documentLayer.style.top = `${-scrollY}px`;
  };
  followScroll();
  window.addEventListener("scroll", followScroll, { passive: true });
  documentLayer.append(layer, threadLayer, commentLayer);
  shadow.append(style, documentLayer, drawingLayer);
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
    send: (action: PageThreadAction | PageOrbAction | PagePanelAction | PageConfirmAction | PageHeldAction) => ipcRenderer.send("page:thread", action),
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
  let drawingCaptures = 0;
  let drawingCaptureVisibility = "";
  const drawing = createDrawingOverlay({
    layer: drawingLayer, attach, forms: hub,
    capture: async () => {
      // Rapid toggles can overlap captures; restore the overlay after the last one finishes.
      if (drawingCaptures++ === 0) {
        drawingCaptureVisibility = host.style.visibility;
        host.style.visibility = "hidden";
      }
      ipcRenderer.send("tooltip:hide");
      try {
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const data = await ipcRenderer.invoke("page:drawing-capture");
        if (typeof data !== "string" || !data.startsWith("data:image/")) throw new Error("Page capture unavailable");
        return data;
      } finally { if (--drawingCaptures === 0) host.style.visibility = drawingCaptureVisibility; }
    },
    snapshot: () => {
      const captured = new Map<string, {sample: CursorSample; rect: DOMRect}>();
      // Capture visible meaningful element centers before installing the opaque drawing surface.
      for (const el of document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,a,button,input,textarea,select,img,li,label,td,th,section,article,[role]")) {
        if (captured.size >= 800) break;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
        const x = (Math.max(0,r.left)+Math.min(innerWidth,r.right))/2;
        const y = (Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2;
        const hit = sampler.sampleAt(x,y);
        if (hit?.sample.elementPath && !captured.has(hit.sample.elementPath)) captured.set(hit.sample.elementPath, {sample:{...hit.sample,t:hit.sample.t+ORIGIN},rect:hit.el.getBoundingClientRect()});
      }
      return [...captured.values()];
    },
    send: (text, sample, annotation) => ipcRenderer.send("page:comment", {type:"comment.send",text,sample,annotation}),
    requestMode: (on) => ipcRenderer.send("drawing:mode",on),
  });
  drawingInput = (event) => {
    if (!drawing.active()) return;
    if (event.type === "pointerdown") talk.pointerdown(); // ⌘/Ctrl-click selects marks: not talking
    // Canvas gestures own their pointer through release even if native capture has ended.
    // Deliver the original event directly, before hit testing controls or making a shadow copy.
    if (event instanceof PointerEvent && drawing.handlePointer(event)) return;
    // The page sees the host, never the closed root's actual input. Redispatch only within that root.
    const pointer = event instanceof MouseEvent;
    const capturedStage = drawingLayer.querySelector<HTMLElement>(".draw-stage");
    const captured = event instanceof PointerEvent && capturedStage?.hasPointerCapture(event.pointerId);
    const target = captured ? capturedStage : pointer ? shadow.elementFromPoint(event.clientX,event.clientY) : shadow.activeElement;
    const surface = drawingLayer.querySelector(".draw-overlay");
    if (!surface) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event instanceof KeyboardEvent && event.key === "Escape") ipcRenderer.send("drawing:mode",false);
      return;
    }
    if (target && !surface.contains(target)) return;
    if (pointer && !target) return;
    event.stopImmediatePropagation();
    if (event instanceof KeyboardEvent) {
      if (event.type === "keyup") talkKeyUp(event);
      else if (event.type === "keydown") talk.keydown(event, talkAllowed(target));
    }
    let copy: Event;
    const common = { bubbles: true, cancelable: event.cancelable, composed: false };
    if (event instanceof PointerEvent) copy = new PointerEvent(event.type, {...common, clientX:event.clientX,clientY:event.clientY,button:event.button,buttons:event.buttons,pointerId:event.pointerId,pointerType:event.pointerType,isPrimary:event.isPrimary,shiftKey:event.shiftKey,ctrlKey:event.ctrlKey,altKey:event.altKey,metaKey:event.metaKey});
    else if (event instanceof WheelEvent) copy = new WheelEvent(event.type,{...common,clientX:event.clientX,clientY:event.clientY,deltaX:event.deltaX,deltaY:event.deltaY,deltaMode:event.deltaMode});
    else if (event instanceof MouseEvent) copy = new MouseEvent(event.type,{...common,clientX:event.clientX,clientY:event.clientY,button:event.button,buttons:event.buttons,shiftKey:event.shiftKey,ctrlKey:event.ctrlKey,altKey:event.altKey,metaKey:event.metaKey});
    else if (event instanceof KeyboardEvent) copy = new KeyboardEvent(event.type,{...common,key:event.key,code:event.code,repeat:event.repeat,shiftKey:event.shiftKey,ctrlKey:event.ctrlKey,altKey:event.altKey,metaKey:event.metaKey,isComposing:event.isComposing});
    else if (event instanceof InputEvent) copy = new InputEvent(event.type,{...common,data:event.data,inputType:event.inputType,isComposing:event.isComposing});
    else copy = new Event(event.type,common);
    // When focus is still on the visited document, Escape and the talk key work from the drawing surface.
    const destination = target ?? surface;
    if (!destination.dispatchEvent(copy)) event.preventDefault();
  };
  ipcRenderer.on("page:drawing-mode", (_e, on: unknown) => { sampler.paused = on === true; if (on === true) comments.setMode(false); void drawing.setMode(on === true); });
  document.addEventListener("vizzo:drawing-preview", (event) => {
    const open = (event as CustomEvent<{open?: boolean}>).detail?.open === true;
    ipcRenderer.send("page:drawing-preview",open);
  });
  ipcRenderer.on("page:drawing-clear", () => { sampler.paused = false; drawing.clear(); });
  void ipcRenderer.invoke("drawing:get").then((on: unknown) => { sampler.paused = on === true; void drawing.setMode(on === true); });
  // Pointing at a marker, its bubble or its panel (or a comment bubble) means its element; the orb means nothing (it's
  // the page as a whole); the rest of the overlay is see-through.
  sampler.pick = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (el !== host) return el;
    const inner = shadow.elementFromPoint(x, y);
    if (inner && threads.isOrb(inner)) return null;
    return (inner && (threads.anchorFor(inner) ?? comments.anchorFor(inner))) ?? document.elementsFromPoint(x, y).find((e) => e !== host) ?? null;
  };
  ipcRenderer.on("page:comment-mode", (_e, on: unknown, keepDraft: unknown) => { if (on === true) void drawing.setMode(false); comments.setMode(on === true, keepDraft === true); });
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
      case "held":
        threads.setHeld(cmd.items);
        break;
      case "provisional":
        threads.provisional(cmd.turnId, cmd.anchor);
        break;
      case "provisional.clear":
        threads.clearProvisional(cmd.turnId);
        break;
      case "comment.state":
        hub.update(cmd.state);
        break;
      case "comment.insert":
        hub.insert(cmd.text, cmd.dictation);
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
