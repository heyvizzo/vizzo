// Comment mode (the pointer button in the browser toolbar): click an element on the page to leave feedback on it.
// The click drops a pin and opens a bubble with an inline form (web/cursor/inlineForm.ts): a text field, a mic
// (dictation into the field) and Send, or + with Instant feedback off. Send closes the bubble (the thread's marker
// shows the comment), and so does + for the first comment on an element; reopened on an element with comments
// queued, the bubble lists them above the form and + adds to them, the bubble staying open for more. While a bubble is open, Shift and always-listen dictate
// into it instead of starting a turn (the chat sidebar decides, web/chat/main.ts).
// Runs in the page preload, in the overlay's closed shadow root (electron/page-preload.ts); `layer` sits at document
// (0,0), so everything is placed in document coords. While the mode is on, clicks on the page are swallowed.
import type { CursorSample } from "../../shared/protocol.ts";
import type { FormHub, InlineForm } from "./inlineForm.ts";

export { insertAtCaret } from "./inlineForm.ts";

const BUBBLE_WIDTH = 300;
const GAP = 10;

export const COMMENT_CSS = `
/* No z-index on the layer: the hover outline goes under the thread layer (z-index 1, its bubbles and markers), the
   pin and bubble over it. */
.cm-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; color: var(--ui-text); }
.cm-hover { position: absolute; box-sizing: border-box; border: 2px solid var(--ui-accent); border-radius: 4px; background: color-mix(in srgb, var(--ui-accent) 8%, transparent); pointer-events: none; z-index: 0; }
.cm-hover-tag { position: absolute; left: -2px; bottom: 100%; margin-bottom: 2px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px/16px ui-sans-serif, system-ui, sans-serif; padding: 0 6px; border-radius: 3px; background: var(--ui-accent-fill); color: var(--ui-on-accent); }
.cm-pin, .cm-bubble { z-index: 2; }
.cm-pin { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; box-sizing: border-box; border-radius: 50% 50% 50% 0; border: 2px solid #fff; background: var(--ui-accent-fill); box-shadow: 0 0 0 1px rgba(0,0,0,.45), 0 1px 4px rgba(0,0,0,.35); pointer-events: none; }
.cm-bubble { position: absolute; width: ${BUBBLE_WIDTH}px; box-sizing: border-box; padding: 8px; display: flex; flex-direction: column; gap: 6px; background: var(--ui-panel); border: 1px solid var(--ui-line); border-radius: 14px; box-shadow: 0 8px 28px var(--ui-shadow); pointer-events: auto; text-align: left; cursor: default; }
.cm-bubble.nudge { animation: cm-nudge .35s ease-in-out; }
.cm-head { display: flex; align-items: center; gap: 6px; padding: 0 0 0 4px; }
.cm-title { flex: 1; min-width: 0; font-size: 12px; color: var(--ui-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cm-title b { color: var(--ui-text); font-weight: 600; }
.cm-close { flex: none; width: 22px; height: 22px; padding: 0; font: 15px/20px ui-sans-serif, system-ui, sans-serif; color: var(--ui-muted); background: transparent; border: 0; border-radius: 50%; cursor: pointer; }
.cm-close:hover { color: var(--ui-text); background: var(--ui-hover); }
.cm-close:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 1px; }
.cm-queued { display: flex; flex-direction: column; gap: 4px; max-height: 160px; overflow: auto; }
.cm-queued-label { font-size: 11px; color: var(--ui-violet); padding: 0 4px; }
.cm-queued-msg { align-self: flex-end; max-width: 90%; padding: 4px 10px; border-radius: 12px 12px 4px 12px; background: color-mix(in srgb, var(--ui-violet) 14%, transparent); border: 1px dashed color-mix(in srgb, var(--ui-violet) 50%, transparent); white-space: pre-wrap; overflow-wrap: anywhere; }
@keyframes cm-nudge { 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }
@media (prefers-reduced-motion: reduce) {
  .cm-bubble.nudge { animation: none; }
}`;

/** While the mode is on, the page's own cursor (the overlay keeps its own). */
const PAGE_CURSOR_CSS = "*, *::before, *::after { cursor: crosshair !important; }";

export interface CommentOverlayOpts {
  /** Positioned at document (0,0), inside the shadow root. */
  layer: HTMLElement;
  /** The shadow host: events whose path contains it happened in the overlay. */
  host: HTMLElement;
  /** Puts the host back if the page removed it. */
  attach(): void;
  /** The page element at a viewport point, as a sample with its details (sees through the overlay). */
  sampleAt(x: number, y: number): { sample: CursorSample; el: Element } | null;
  /** The bubble's form, its dictation, and sending (web/cursor/inlineForm.ts). */
  forms: FormHub;
  /** The texts queued (Instant off) on the element at this DOM path, in order. */
  queuedOn(domPath: string): string[];
  /** Ask for the mode to change (Esc turns it off); the answer comes back through setMode. */
  requestMode(on: boolean): void;
}

export interface CommentOverlay {
  /** keepDraft: leaving the mode keeps an empty bubble open (Caps Lock let go after clicking an element). */
  setMode(on: boolean, keepDraft?: boolean): void;
  /** The queue or the dictation changed: redraw the open bubble. */
  refresh(): void;
  /** The page element a node of the overlay stands for: the open bubble or its pin → the clicked element. */
  anchorFor(node: Node): Element | null;
  /** Opens a bubble on the element at a viewport point, with or without the mode (right-click → Add feedback). */
  openAt(x: number, y: number): void;
  /** Settings → Hover outline: draw the hover box outside the mode too, to check what's being pointed at (clicks pass). */
  setAlwaysHover(on: boolean): void;
}

// ── pure helpers ──

/**
 * Where the bubble goes (document coords) for a pin at (px, py): below-right of it, flipped left / above when it
 * wouldn't fit in the viewport (scrolled by sx, sy, size vw × vh), and kept inside it.
 */
export function bubblePosition(px: number, py: number, width: number, height: number, view: { sx: number; sy: number; vw: number; vh: number }): { left: number; top: number } {
  const right = px + GAP;
  const left = right + width <= view.sx + view.vw - GAP ? right : px - GAP - width;
  const below = py + GAP;
  const top = below + height <= view.sy + view.vh - GAP ? below : py - GAP - height;
  return {
    left: Math.max(view.sx + GAP, Math.min(left, view.sx + view.vw - width - GAP)),
    top: Math.max(view.sy + GAP, top),
  };
}

/** What the bubble says it's about: the element's label, else its tag. */
export function targetName(s: Pick<CursorSample, "label" | "elementPath">): string {
  const label = s.label?.replace(/\s+/g, " ").trim();
  if (label) return label.length > 40 ? `${label.slice(0, 39)}…` : label;
  const last = s.elementPath?.split(">").pop()?.trim() ?? "";
  return /^[a-z][a-z0-9-]*/i.exec(last)?.[0]?.toLowerCase() ?? "element";
}

// ── the overlay ──

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

interface Draft {
  sample: CursorSample;
  el: Element;
  /** Pin, document coords. */
  x: number;
  y: number;
  pin: HTMLElement;
  bubble: HTMLElement;
  queued: HTMLElement;
  form: InlineForm;
}

export function createCommentOverlay(opts: CommentOverlayOpts): CommentOverlay {
  const { layer, host, forms } = opts;
  layer.classList.add("cm-layer");
  const shadow = layer.getRootNode() as ShadowRoot | Document;
  let on = false;
  /** Hover outline outside the mode as well (setAlwaysHover). */
  let always = false;
  let draft: Draft | null = null;
  const hover = h("div", "cm-hover");
  const hoverTag = h("span", "cm-hover-tag");
  hover.append(hoverTag);
  hover.hidden = true;
  layer.append(hover);
  let pageCursor: HTMLStyleElement | null = null;

  // Clicks, presses and keys in the overlay stay in the overlay (the page's own handlers don't see them).
  for (const type of ["click", "pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "keydown", "keyup", "keypress", "input", "contextmenu"]) {
    layer.addEventListener(type, (e) => e.stopPropagation());
  }

  const inOverlay = (e: Event) => e.composedPath().includes(host);
  const view = () => ({ sx: scrollX, sy: scrollY, vw: innerWidth, vh: innerHeight });
  /** Dictating into the bubble, or its words are on the way. */
  const dictating = () => forms.state().recording || forms.state().transcribing;
  /** Words not sent yet: never thrown away by a click elsewhere or by leaving the mode. */
  const unsent = (d: Draft) => !!d.form.value().trim() || dictating();

  // ── hover box ──

  let hoverAt: { x: number; y: number } | null = null;
  let hoverFrame = 0;
  function drawHover(): void {
    hoverFrame = 0;
    const p = hoverAt;
    const hit = (on || always) && p ? opts.sampleAt(p.x, p.y) : null;
    const r = hit?.el.getBoundingClientRect();
    if (!hit || !r || (r.width === 0 && r.height === 0)) { hover.hidden = true; return; }
    opts.attach();
    hover.hidden = false;
    hover.style.left = `${r.left + scrollX}px`;
    hover.style.top = `${r.top + scrollY}px`;
    hover.style.width = `${r.width}px`;
    hover.style.height = `${r.height}px`;
    hoverTag.textContent = on ? `Comment on ${targetName(hit.sample)}` : targetName(hit.sample);
  }
  const onMove = (e: PointerEvent) => {
    hoverAt = inOverlay(e) ? null : { x: e.clientX, y: e.clientY };
    if (!hoverAt) { hover.hidden = true; return; }
    hoverFrame ||= requestAnimationFrame(drawHover);
  };
  /** The pointer left the page: no element is under it. */
  const onOut = (e: MouseEvent) => {
    if (e.relatedTarget) return;
    hoverAt = null;
    hover.hidden = true;
  };
  let tracking = false;
  /** Follow the pointer while the mode or the always-on outline wants the hover box. */
  function track(): void {
    const want = on || always;
    if (want === tracking) return;
    tracking = want;
    if (want) {
      window.addEventListener("pointermove", onMove, { capture: true, passive: true });
      document.addEventListener("mouseout", onOut, true);
    } else {
      window.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("mouseout", onOut, true);
      hover.hidden = true;
      hoverAt = null;
    }
  }

  // ── clicks on the page ──

  /** The page's presses and clicks while the mode is on: swallowed; a primary click opens a bubble there. */
  const swallow = (e: MouseEvent) => {
    if (!on || inOverlay(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === "click" && e.button === 0) openDraft(e.clientX, e.clientY);
  };
  const SWALLOWED = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "auxclick"] as const;

  function setMode(next: boolean, keepDraft = false): void {
    if (next === on) return;
    on = next;
    track();
    if (on) {
      for (const t of SWALLOWED) window.addEventListener(t, swallow as EventListener, true);
      pageCursor = document.createElement("style");
      pageCursor.textContent = PAGE_CURSOR_CSS;
      (document.head ?? document.documentElement).append(pageCursor);
    } else {
      for (const t of SWALLOWED) window.removeEventListener(t, swallow as EventListener, true);
      pageCursor?.remove();
      pageCursor = null;
      if (!always) { hover.hidden = true; hoverAt = null; }
      // An empty bubble goes with the mode (unless asked to stay); one with words stays until it's sent or discarded.
      if (draft && !unsent(draft) && !keepDraft) closeDraft();
    }
  }

  // ── the bubble ──

  function closeDraft(): void {
    const d = draft;
    if (!d) return;
    draft = null;
    d.form.destroy(); // stops its dictation; the chat hears the bubble closed
    d.pin.remove();
    d.bubble.remove();
  }

  function placeBubble(d: Draft): void {
    const { left, top } = bubblePosition(d.x, d.y, BUBBLE_WIDTH, d.bubble.offsetHeight || 90, view());
    d.bubble.style.left = `${left}px`;
    d.bubble.style.top = `${top}px`;
  }

  function nudge(d: Draft): void {
    d.bubble.classList.remove("nudge");
    void d.bubble.offsetWidth; // restart the animation
    d.bubble.classList.add("nudge");
    d.form.focus();
  }

  /** What's queued on the bubble's element (Instant off), above the form. */
  function renderQueued(d: Draft): void {
    const texts = opts.queuedOn(d.sample.details?.domPath ?? d.sample.elementPath ?? "");
    d.queued.hidden = !texts.length;
    d.queued.replaceChildren(
      ...(texts.length ? [h("div", "cm-queued-label", `Not sent yet · ${texts.length}`)] : []),
      ...texts.map((t) => h("div", "cm-queued-msg", t)),
    );
    d.queued.scrollTop = d.queued.scrollHeight;
  }

  function openDraft(x: number, y: number): void {
    if (draft && unsent(draft)) return nudge(draft);
    const hit = opts.sampleAt(x, y);
    if (!hit) return;
    if (draft) closeDraft();
    opts.attach();
    hit.sample.t += performance.timeOrigin; // crosses the bridge as epoch ms
    const pin = h("div", "cm-pin");
    pin.setAttribute("aria-hidden", "true");
    const bubble = h("div", "cm-bubble");
    bubble.setAttribute("role", "dialog");
    const name = targetName(hit.sample);
    bubble.setAttribute("aria-label", `Comment on ${name}`);
    const title = h("div", "cm-title");
    title.append("Comment on ", h("b", undefined, name));
    const close = h("button", "cm-close", "×");
    close.type = "button";
    close.dataset.tip = "Close (Esc when empty)";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("pointerdown", (e) => e.preventDefault());
    close.onclick = () => closeDraft();
    const head = h("div", "cm-head");
    head.append(title, close);
    const queued = h("div", "cm-queued");
    const d: Draft = {
      sample: hit.sample, el: hit.el, x: x + scrollX, y: y + scrollY, pin, bubble, queued,
      form: forms.create({
        placeholder: "What should change? Type, or hold Shift to talk",
        submit: (text) => submit(d, text),
        escape: (empty) => { if (empty) closeDraft(); else d.form.field.blur(); },
      }),
    };
    bubble.append(head, queued, d.form.root);
    layer.append(pin, bubble);
    draft = d;
    pin.style.left = `${d.x}px`;
    pin.style.top = `${d.y}px`;
    renderQueued(d);
    placeBubble(d);
    d.form.focus();
  }

  function submit(d: Draft, text: string): void {
    const instant = forms.state().instant;
    forms.send(text, d.sample);
    // The first comment on the element (nothing queued on it yet) closes the bubble, like Send: its marker shows it.
    const first = d.queued.hidden;
    if (!instant && !first) {
      // Added to a list already shown above the form: it joins it there; the bubble stays for more.
      d.form.clear();
      d.form.focus();
      return;
    }
    // Sent, or the first one added to the list: the thread's marker shows it.
    closeDraft();
  }

  // Esc outside the field: close an empty bubble, else leave the mode.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented || !(on || draft)) return;
    if (draft && shadow.activeElement === draft.form.field) return; // the field's own handler
    e.preventDefault();
    if (draft && !unsent(draft)) closeDraft();
    else if (on) opts.requestMode(false);
  }, true);

  window.addEventListener("resize", () => { if (draft) placeBubble(draft); });

  return {
    setMode,
    refresh() {
      if (!draft) return;
      renderQueued(draft);
      placeBubble(draft);
    },
    anchorFor(node) {
      if (!draft || !(draft.bubble.contains(node) || draft.pin.contains(node))) return null;
      return draft.el.isConnected ? draft.el : null;
    },
    openAt: openDraft,
    setAlwaysHover(next) {
      always = next;
      track();
      if (hoverAt) hoverFrame ||= requestAnimationFrame(drawHover); // the tag's wording follows the mode
    },
  };
}
