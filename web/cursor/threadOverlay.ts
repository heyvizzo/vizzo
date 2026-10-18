// Element threads on the page (docs/PLAN-threads.md): a marker at the top-right corner of each thread's element, the
// thread panel (history, files, an inline form to follow up by typing or dictating, delete with an in-panel
// confirmation), the bubbles of its spoken lines, and the
// provisional marker drawn at release until the turn's thread is known. Runs in the page preload, inside its closed
// shadow root (electron/page-preload.ts); `layer` sits at document (0,0), so everything is placed in document coords.
// Elements are re-resolved on scroll, resize, DOM mutation (HMR included): selector → role + text → the anchor's
// last bounds (drawn faded). The conversation orb stands for the page as a whole: the central conversation's bubbles
// come from it and its panel shows the conversation. It sits fixed in the viewport, bottom center until dragged.
import { displayTitle, type ThreadAnchor, type ThreadInfo, type ThreadMessage, type ThreadSay, type ThreadState } from "../../shared/threads.ts";
import { stripVoiceCues } from "../../shared/cues.ts";
import type { CursorSample } from "../../shared/protocol.ts";
import type { FormHub, InlineForm } from "./inlineForm.ts";
import type { ConvoEntry, OrbPos, OrbState, PageOrbAction, PageThreadAction } from "./pageBridge.ts";
import { mountOrb } from "@yogesharc/thinking-orbs/vanilla";

const MARKER = 20;
/** Markers of threads on one element sit side by side, this far apart. */
const MARKER_STEP = 24;
const RESOLVE_THROTTLE_MS = 250;
/** Layout can change without a mutation (transitions, fonts): re-resolve this often while markers are shown. */
const RESOLVE_EVERY_MS = 1000;
/** Leaving the bubble or its marker collapses the bubble after this long (time to cross the gap between them). */
const COLLAPSE_DELAY_MS = 180;
/** The bubble's tail: a rotated square of this side whose tip sits about TAIL_REACH px below the bubble. */
const TAIL = 10;
const TAIL_REACH = 7;
/** The bubble's and panel's right edge sits this far right of the marker's center, so the tail clears the corner. */
const OVERHANG = 16;
/** Vertical room between a marker's edge and a bubble or panel: the tail plus a hair. */
const TAIL_GAP = TAIL_REACH + 2;
/** White check on a done marker. */
const CHECK = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6.2l2.3 2.3 4.7-5' fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;
/** The panel header's delete button. */
const ICON_TRASH = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 4.5h11M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6M6.8 7v4.5M9.2 7v4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
/** The conversation orb, and how far its bottom edge sits above the viewport's bottom before it's dragged. */
const ORB = 56;
const ORB_BOTTOM = 25;
/**
 * The thinking orb drawn inside it (@yogesharc/thinking-orbs), one look per state: a plain spin when idle, a pulse
 * like a recording light while listening, a wandering spark while working, and blinking in amber when the last reply
 * asked you something (its bubble then needs no amber border of its own).
 */
const ORB_DOTS = 52;
const ORB_LOOKS = {
  idle: { state: "idle" },
  listening: { state: "using", variant: "record" },
  running: { state: "reasoning" },
  asking: { state: "idle", variant: "blink" },
} as const satisfies Record<OrbState, Parameters<typeof mountOrb>[1]>;
/** The orb is kept this far inside the viewport. */
const ORB_MARGIN = 4;
/** A press on the orb that moves more than this is a drag, not a click. */
const DRAG_SLOP = 4;
const PANEL_WIDTH = 340;
const PANEL_GAP = 8;

export const THREAD_CSS = `
.th-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 1; font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #e6e8ee; }
.th-marker { position: absolute; width: ${MARKER}px; height: ${MARKER}px; margin: -${MARKER / 2}px 0 0 -${MARKER / 2}px; padding: 0; box-sizing: border-box; border-radius: 50%; border: 3px solid #fff; background: #6366f1; box-shadow: 0 0 0 1px #000; cursor: pointer; pointer-events: auto; z-index: 1; }
.th-marker:focus-visible { outline: 2px solid #6ea8fe; outline-offset: 2px; }
.th-marker[data-state="running"] { animation: th-ring 1.4s ease-out infinite; }
.th-marker[data-state="idle"], .th-marker[data-state="pending"] { background: #22c55e ${CHECK} center / 10px no-repeat; }
.th-marker[data-state="failed"] { background: #ef4444; }
.th-marker[data-state="queued"] { background: #a78bfa; opacity: .55; }
.th-marker.faded { opacity: .5; }
.th-marker.open { box-shadow: 0 0 0 1px #000, 0 0 0 4px rgba(110,168,254,.6); }
.th-orb { position: fixed; width: ${ORB}px; height: ${ORB}px; margin: -${ORB / 2}px 0 0 -${ORB / 2}px; padding: 0; display: grid; place-items: center; box-sizing: border-box; border-radius: 50%; border: 0; background: none; color: #6366f1; cursor: grab; pointer-events: auto; touch-action: none; z-index: 1; }
.th-orb svg { display: block; pointer-events: none; }
.th-orb:focus-visible { outline: 2px solid #6ea8fe; outline-offset: 2px; }
.th-orb.dragging { cursor: grabbing; }
.th-orb[data-state="listening"] { color: #ef4444; }
.th-orb[data-state="asking"] { color: #f59e0b; }
.th-orb.open { box-shadow: 0 0 0 3px rgba(110,168,254,.6); }
.th-bubble.fixed, .th-panel.fixed { position: fixed; }
.th-prov { position: absolute; width: ${MARKER}px; height: ${MARKER}px; margin: -${MARKER / 2}px 0 0 -${MARKER / 2}px; box-sizing: border-box; border-radius: 50%; border: 3px solid #fff; background: #a3a3a3; box-shadow: 0 0 0 1px #000; animation: th-pulse 1.2s ease-in-out infinite; }
@keyframes th-ring { 0% { box-shadow: 0 0 0 1px #000, 0 0 0 0 rgba(99,102,241,.6); } 100% { box-shadow: 0 0 0 1px #000, 0 0 0 12px rgba(99,102,241,0); } }
@keyframes th-pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) {
  .th-marker[data-state="running"] { animation: none; box-shadow: 0 0 0 1px #000, 0 0 0 3px rgba(99,102,241,.45); }
  .th-prov { animation: none; }
  .th-bubble, .th-bubble.collapsed { transition: opacity .15s linear; }
  .th-bubble.collapsed { --s: 1; }
}
/* Collapsed, the bubble shrinks into its marker: scaled about its tail's tip, which sits on the marker. */
.th-bubble { --s: 1; position: absolute; transform: translate(-100%, -100%) scale(var(--s)); transform-origin: calc(100% - var(--tail-right, 11px) - ${TAIL / 2}px) calc(100% + ${TAIL_REACH}px); max-width: 280px; width: max-content; padding: 6px 10px; box-sizing: border-box; border-radius: 12px; background: #1f232c; border: 1px solid #3b4a6b; box-shadow: 0 2px 10px rgba(0,0,0,.35); white-space: pre-wrap; overflow-wrap: anywhere; pointer-events: auto; cursor: default; transition: transform .22s cubic-bezier(.2,.9,.3,1.15), opacity .18s linear; z-index: 2; }
.th-bubble.collapsed { --s: 0; opacity: 0; pointer-events: none; transition: transform .2s cubic-bezier(.5,0,.75,0), opacity .2s linear; }
.th-bubble::after, .th-panel::before { content: ""; position: absolute; right: var(--tail-right, 11px); width: ${TAIL}px; height: ${TAIL}px; box-sizing: border-box; background: inherit; border: solid #3b4a6b; transform: rotate(45deg); }
.th-bubble::after { bottom: -${TAIL / 2 + 1}px; border-width: 0 1px 1px 0; }
.th-bubble[data-side="below"] { transform: translateX(-100%) scale(var(--s)); transform-origin: calc(100% - var(--tail-right, 11px) - ${TAIL / 2}px) -${TAIL_REACH}px; }
.th-bubble[data-side="below"]::after { bottom: auto; top: -${TAIL / 2 + 1}px; border-width: 1px 0 0 1px; }
.th-bubble.reply { border-color: #b7791f; }
.th-bubble.reply::after { border-color: #b7791f; }
.th-panel { position: absolute; width: ${PANEL_WIDTH}px; max-height: 420px; display: flex; flex-direction: column; box-sizing: border-box; background: #171a21; border: 1px solid #2a2f3a; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.45); pointer-events: auto; z-index: 3; text-align: left; }
.th-panel::before { border-color: #2a2f3a; top: -${TAIL / 2 + 1}px; border-width: 1px 0 0 1px; }
.th-panel[data-side="above"]::before { top: auto; bottom: -${TAIL / 2 + 1}px; border-width: 0 1px 1px 0; }
.th-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px; }
.th-title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.th-state { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid #2a2f3a; color: #8a93a6; }
.th-state[data-state="running"] { color: #a5b4fc; border-color: #44396b; }
.th-state[data-state="pending"] { color: #4ade80; border-color: #1f4d33; }
.th-state[data-state="failed"] { color: #f87171; border-color: #5b2424; }
.th-state[data-state="idle"] { color: #4ade80; border-color: #1f4d33; }
.th-state[data-state="queued"] { color: #c4b5fd; border-color: #3f3566; }
.th-panel button { font: inherit; font-size: 12px; color: inherit; background: #222733; border: 1px solid #2a2f3a; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.th-panel button:hover { border-color: #6ea8fe; }
.th-panel button:focus-visible { outline: 2px solid #6ea8fe; outline-offset: 1px; }
.th-panel .th-close { padding: 0 7px; font-size: 15px; line-height: 20px; border: 0; background: transparent; color: #8a93a6; }
.th-panel .th-trash { display: flex; align-items: center; padding: 3px 5px; border: 0; background: transparent; color: #8a93a6; }
.th-panel .th-trash:hover { color: #fca5a5; }
.th-summary { padding: 0 12px 8px; font-size: 12px; color: #8a93a6; }
.th-body { flex: 1; min-height: 0; overflow: auto; padding: 0 12px 8px; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid #2a2f3a; padding-top: 8px; }
.th-msg { border-left: 2px solid #2a2f3a; padding-left: 8px; }
.th-msg.role-user { border-left-color: #3b5b8f; }
.th-msg.role-assistant { border-left-color: #2f6b4b; }
.th-msg.role-system { border-left-color: #6b5a2f; }
.th-msg.kind-error { border-left-color: #b91c1c; }
.th-meta { font: 10.5px ui-monospace, monospace; color: #8a93a6; }
.th-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.th-msg details summary { cursor: pointer; color: #6ea8fe; font-size: 12px; }
.th-msg pre { margin: 4px 0 0; padding: 6px 8px; max-height: 220px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 ui-sans-serif, system-ui, sans-serif; background: #13161c; border: 1px solid #2a2f3a; border-radius: 6px; }
.th-files { margin-top: 2px; font: 11px ui-monospace, monospace; color: #9fd8b5; overflow-wrap: anywhere; }
.th-empty { color: #8a93a6; font-style: italic; }
.th-turn { display: flex; flex-direction: column; gap: 4px; }
.th-turn.note { opacity: .7; }
.th-msg.queued { border-left-style: dashed; border-left-color: #a78bfa; opacity: .85; }
.th-compose { padding: 8px 12px; border-top: 1px solid #2a2f3a; }
.th-foot { display: flex; align-items: center; gap: 8px; padding: 8px 12px 10px; border-top: 1px solid #2a2f3a; }
.th-foot .th-confirm { flex: 1; font-size: 12px; }
.th-foot .th-danger { border-color: #7f1d1d; color: #fca5a5; }
.th-foot .th-danger:hover { border-color: #f87171; }
.th-foot .spacer { flex: 1; }`;

export interface ThreadOverlayOpts {
  /** Positioned at document (0,0), inside the shadow root. */
  layer: HTMLElement;
  /** The shadow host: events whose path contains it happened in the overlay. */
  host: HTMLElement;
  /** Puts the host back if the page removed it. */
  attach(): void;
  /** The element under the pointer at the last sample (the provisional marker's spot). */
  pointed(): Element | null;
  /** The pointer's last sampled position in document coordinates (where the provisional dot goes on that element). */
  pointer?(): { x: number; y: number } | null;
  send(action: PageThreadAction | PageOrbAction): void;
  /** The page element at a viewport point, as a sample (a marker stands for its thread's element). */
  sampleAt(x: number, y: number): { sample: CursorSample } | null;
  /** The panel's form, its dictation, and sending (web/cursor/inlineForm.ts). */
  forms: FormHub;
  now?: () => number;
}

export interface ThreadOverlay {
  setThreads(threads: ThreadInfo[]): void;
  bubble(say: ThreadSay, ended: boolean): void;
  provisional(turnId: string): void;
  clearProvisional(turnId: string): void;
  /** Open a thread's panel and scroll its element into view (from the sidebar's list). */
  open(threadId: string): void;
  /** The orb's state, and where it was dragged to (null: bottom center). */
  setOrb(state: OrbState, pos: OrbPos | null): void;
  /** The conversation shown in the orb's panel. */
  setConversation(entries: ConvoEntry[]): void;
  /** The node is the orb, its bubble or its panel: it stands for no element (pointing at it points at nothing). */
  isOrb(node: Node): boolean;
  /**
   * The page element a node of the overlay stands for: a marker, its bubble or its panel → the thread's element
   * (pointing at a marker means its element). Null for other overlay nodes or an element not found on the page.
   */
  anchorFor(node: Node): Element | null;
  /** The texts queued (Instant off) on the element at this DOM path on this page, in order. */
  queuedOn(domPath: string): string[];
}

// ── pure helpers ──

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** The element's text against the anchor's (capped, maybe with "…") or its label. */
export function textMatches(elText: string | null, ariaLabel: string | null, a: Pick<ThreadAnchor, "text" | "label">): boolean {
  const text = norm(elText);
  const want = norm(a.text).replace(/…$/, "");
  if (want && text && (text === want || (want.length >= 12 && text.startsWith(want)))) return true;
  const label = norm(a.label);
  return !!label && (norm(ariaLabel) === label || text === label);
}

/**
 * Where a thread's dot goes (document coords): the point the user pointed at, kept at the same relative spot on the
 * element as it moves or resizes (clamped inside it); the element's center without a point.
 */
export function markerPoint(
  a: Pick<ThreadAnchor, "bounds" | "point">, live: { x: number; y: number; width: number; height: number } | null,
): { x: number; y: number } {
  const r = live ?? a.bounds;
  const b = a.bounds;
  const rel = (p: number, start: number, size: number) => (size > 0 ? Math.min(1, Math.max(0, (p - start) / size)) : 0.5);
  if (!a.point) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  if (!live) return { ...a.point };
  return { x: r.x + rel(a.point.x, b.x, b.width) * r.width, y: r.y + rel(a.point.y, b.y, b.height) * r.height };
}

/** The panel's delete confirmation. */
export function deleteConfirmText(state: ThreadState): string {
  if (state === "queued") return "Delete this feedback? It won't be sent.";
  return state === "running" ? "It's still working — stop it and delete?" : "Delete this thread? Its edits stay in the code.";
}

/** A finished thread (idle, pending) has no label: the marker's check says it. */
export const STATE_LABEL: Record<ThreadState, string> = { running: "working", pending: "", idle: "", failed: "failed", queued: "not sent" };

/**
 * Where the panel goes (document coords) for a marker at (mx, my): below it, its right edge just past the marker,
 * kept inside the viewport (scrolled by sx, sy, size vw × vh); above the marker when there's no room below.
 * `radius`: the marker's (the orb is bigger).
 * `tailRight` places the tail (from the panel's right edge) so it points at the marker.
 */
export function panelPosition(
  mx: number, my: number, height: number, view: { sx: number; sy: number; vw: number; vh: number }, radius = MARKER / 2,
): { left: number; top: number; side: "below" | "above"; tailRight: number } {
  const left = Math.max(view.sx + PANEL_GAP, Math.min(mx + OVERHANG - PANEL_WIDTH, view.sx + view.vw - PANEL_WIDTH - PANEL_GAP));
  const below = my + radius + TAIL_GAP;
  const above = my - radius - TAIL_GAP - height;
  const side = below + height <= view.sy + view.vh || above < view.sy ? "below" : "above";
  return { left, top: side === "below" ? below : above, side, tailRight: tailOffset(left + PANEL_WIDTH, mx, PANEL_WIDTH) };
}

/** The tail's offset from a box's right edge (at `right`, `width` wide) so it points at x, kept off the corners. */
function tailOffset(right: number, x: number, width: number): number {
  return Math.max(8, Math.min(right - x - TAIL / 2, width - TAIL - 8));
}

// ── element resolution ──

function queryAll(sel: string | null | undefined): Element[] {
  if (!sel) return [];
  try {
    return [...document.querySelectorAll(sel)];
  } catch {
    return [];
  }
}

const matches = (el: Element, a: ThreadAnchor) => textMatches(el.textContent, el.getAttribute("aria-label"), a);

/** The live element for an anchor, or null (then its last bounds are used). `prev` is kept while it's in the page. */
/**
 * The orb's center in viewport coords: where it was dragged to (fractions of the viewport), else bottom center with its
 * bottom edge ORB_BOTTOM above the viewport's bottom. Kept inside the viewport.
 */
export function orbPoint(pos: OrbPos | null, vw: number, vh: number): { x: number; y: number } {
  const r = ORB / 2;
  const clamp = (v: number, size: number) => Math.max(r + ORB_MARGIN, Math.min(v, size - r - ORB_MARGIN));
  return pos ? { x: clamp(pos.x * vw, vw), y: clamp(pos.y * vh, vh) } : { x: clamp(vw / 2, vw), y: clamp(vh - ORB_BOTTOM - r, vh) };
}

export function resolveAnchor(a: ThreadAnchor, prev: Element | null): Element | null {
  if (prev?.isConnected) return prev;
  for (const sel of [a.domPath, a.selector]) {
    const hits = queryAll(sel);
    if (hits.length === 1) return hits[0]!;
    const hit = hits.find((el) => matches(el, a));
    if (hit) return hit;
  }
  if (!a.text && !a.label) return null;
  const candidates = queryAll(a.role ? `[role="${CSS.escape(a.role)}"]` : a.tag);
  return candidates.find((el) => matches(el, a)) ?? null;
}

// ── the overlay ──

interface MarkerView { thread: ThreadInfo; el: Element | null; btn: HTMLButtonElement; x: number; y: number; faded: boolean }
/** Where a bubble or panel points: a marker (document coords) or the orb (viewport coords: `fixed`). */
interface Spot { x: number; y: number; r: number; fixed: boolean }
/** `home`: where the bubble points with no marker (the viewport's top-right when it appeared). */
/** `collapsed`: shrunk into its marker (hovering the marker grows it back out). `leave`: the pending collapse. */
interface BubbleView {
  say: ThreadSay; div: HTMLElement; home: { x: number; y: number };
  collapsed: boolean; leave: ReturnType<typeof setTimeout> | null;
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createThreadOverlay(opts: ThreadOverlayOpts): ThreadOverlay {
  const { layer, host } = opts;
  const now = opts.now ?? (() => performance.now());
  layer.classList.add("th-layer");
  const markers = new Map<string, MarkerView>();
  const bubbles = new Map<string, BubbleView>();
  /** The provisional dot: where the pointer was on its element at release (bounds/point as in ThreadAnchor). */
  let prov: {
    turnId: string; el: Element | null; div: HTMLElement; x: number; y: number;
    bounds: ThreadAnchor["bounds"] | null; point: { x: number; y: number } | null;
  } | null = null;
  /** `view`: the viewport when it opened; the panel is placed against it, so it stays put as the page scrolls. */
  /** `threadId` null: the orb's panel (the conversation; no form). */
  let panel: {
    threadId: string | null; root: HTMLElement; form: InlineForm | null; confirming: boolean; openDetails: Set<string>;
    /** Messages already shown: a new one is scrolled into view. */
    seen: Set<string>;
    /**
     * The new message being scrolled to, until it's reached: the body is rebuilt on every update, which would stop a
     * smooth scroll half-way (the thread's state changes right after its message arrives).
     */
    goal: string | null;
    view: { sx: number; sy: number; vw: number; vh: number };
  } | null = null;
  /** Asked to open before the thread arrived. */
  let pendingOpen: string | null = null;
  /** The orb: `x`, `y` its center in viewport coords. `drag`: a press on it, a drag once it moved past DRAG_SLOP. */
  const orb = {
    btn: h("button", "th-orb"), state: "idle" as OrbState, pos: null as OrbPos | null, x: 0, y: 0,
    drag: null as { id: number; x0: number; y0: number; dx: number; dy: number; moved: boolean } | null,
    /** The click that ends a drag doesn't open the panel. */
    dragged: false,
  };
  let entries: ConvoEntry[] = [];

  // Clicks, presses and keys in the overlay stay in the overlay (the page's own handlers don't see them).
  for (const type of ["click", "pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "keydown", "keyup", "keypress", "input", "contextmenu"]) {
    layer.addEventListener(type, (e) => e.stopPropagation());
  }

  // ── positions ──

  const docRect = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width === 0 && r.height === 0 ? null : { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
  };

  function resolveAll(): void {
    opts.attach();
    for (const m of markers.values()) m.el = resolveAnchor(m.thread.anchor, m.el);
    if (prov?.el && !prov.el.isConnected) prov.el = null;
    position();
  }

  function placeOrb(): void {
    ({ x: orb.x, y: orb.y } = orbPoint(orb.pos, innerWidth, innerHeight));
    orb.btn.style.left = `${orb.x}px`;
    orb.btn.style.top = `${orb.y}px`;
  }

  function position(): void {
    placeOrb();
    const perSpot = new Map<string, number>();
    for (const m of markers.values()) {
      const live = m.el && docRect(m.el);
      const p = markerPoint(m.thread.anchor, live || null);
      // Several threads on one spot sit side by side.
      const spot = `${Math.round(p.x / MARKER)},${Math.round(p.y / MARKER)}`;
      const n = perSpot.get(spot) ?? 0;
      perSpot.set(spot, n + 1);
      m.x = p.x + n * MARKER_STEP;
      m.y = p.y;
      m.faded = !live;
      m.btn.classList.toggle("faded", m.faded);
      m.btn.style.left = `${m.x}px`;
      m.btn.style.top = `${m.y}px`;
    }
    if (prov) {
      const r = prov.el && docRect(prov.el);
      prov.div.hidden = !r;
      if (r) {
        ({ x: prov.x, y: prov.y } = markerPoint({ bounds: prov.bounds ?? r, point: prov.point ?? undefined }, r));
        prov.div.style.left = `${prov.x}px`;
        prov.div.style.top = `${prov.y}px`;
      }
    }
    for (const b of bubbles.values()) placeBubble(b);
    placePanel();
  }

  let frame = 0;
  const schedulePosition = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; position(); });
  };
  let resolveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastResolve = 0;
  const scheduleResolve = () => {
    if (resolveTimer || (!markers.size && !prov)) return;
    const wait = Math.max(0, lastResolve + RESOLVE_THROTTLE_MS - now());
    resolveTimer = setTimeout(() => { resolveTimer = null; lastResolve = now(); resolveAll(); }, wait);
  };
  window.addEventListener("scroll", schedulePosition, { capture: true, passive: true });
  window.addEventListener("resize", schedulePosition);
  new MutationObserver(scheduleResolve).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  setInterval(() => { if (markers.size || prov) resolveAll(); else opts.attach(); }, RESOLVE_EVERY_MS);

  // ── markers ──

  function renderMarker(m: MarkerView): void {
    const t = m.thread;
    m.btn.dataset.state = t.state;
    m.btn.classList.toggle("open", panel?.threadId === t.threadId);
    const label = [displayTitle(t.title), STATE_LABEL[t.state], t.unread ? "unread" : ""].filter(Boolean).join(" · ");
    // No native tooltip: hovering a marker grows its bubble out instead.
    m.btn.setAttribute("aria-label", t.summary ? `${label}. ${stripVoiceCues(t.summary)}` : label);
  }

  /** Hovering the orb when it has a bubble grows the bubble out: no native tooltip on top of it. */
  function tipUnlessBubble(btn: HTMLElement, b: BubbleView | undefined): void {
    btn.title = b ? "" : btn.dataset.tip ?? "";
  }

  function setThreads(threads: ThreadInfo[]): void {
    const ids = new Set(threads.map((t) => t.threadId));
    for (const [id, m] of markers) {
      if (ids.has(id)) continue;
      m.btn.remove();
      markers.delete(id);
      for (const [sayId, b] of bubbles) if (b.say.threadId === id) removeBubble(sayId);
      if (panel?.threadId === id) closePanel();
    }
    let added = false;
    for (const t of threads) {
      let m = markers.get(t.threadId);
      if (!m) {
        const btn = h("button", "th-marker");
        btn.type = "button";
        btn.addEventListener("click", () => (panel?.threadId === t.threadId ? closePanel() : openPanel(t.threadId)));
        btn.addEventListener("pointerenter", () => { const b = bubbleOf(t.threadId); if (b && panel?.threadId !== t.threadId) expand(b); });
        btn.addEventListener("pointerleave", () => { const b = bubbleOf(t.threadId); if (b) collapseSoon(b); });
        layer.append(btn);
        m = { thread: t, el: null, btn, x: 0, y: 0, faded: true };
        markers.set(t.threadId, m);
        added = true;
      }
      m.thread = t;
      renderMarker(m);
    }
    // The turn's thread has arrived: it replaces the provisional marker.
    if (added && prov) clearProv();
    resolveAll();
    if (panel) renderPanel();
    if (pendingOpen && markers.has(pendingOpen)) open(pendingOpen);
  }

  // ── provisional marker ──

  function clearProv(): void {
    prov?.div.remove();
    prov = null;
  }

  function provisional(turnId: string): void {
    clearProv();
    const div = h("div", "th-prov");
    div.setAttribute("aria-hidden", "true");
    layer.append(div);
    const el = opts.pointed();
    prov = { turnId, el, div, x: 0, y: 0, bounds: el && docRect(el), point: opts.pointer?.() ?? null };
    position();
  }

  // ── bubbles ──

  /** A thread's marker, or the orb for the central conversation (null). */
  function spotOf(threadId: string | null): Spot | null {
    if (threadId === null) return { x: orb.x, y: orb.y, r: ORB / 2, fixed: true };
    const m = markers.get(threadId);
    return m ? { x: m.x, y: m.y, r: MARKER / 2, fixed: false } : null;
  }

  /** Where a bubble points: its thread's marker (the orb for central lines), else the provisional marker, else its home. */
  function bubbleAnchor(b: BubbleView): Spot {
    const s = spotOf(b.say.threadId);
    if (s) return s;
    if (prov && !prov.div.hidden) return { x: prov.x, y: prov.y, r: MARKER / 2, fixed: false };
    return { ...b.home, r: MARKER / 2, fixed: false };
  }

  function placeBubble(b: BubbleView): void {
    const { x, y, r, fixed } = bubbleAnchor(b);
    // Above the marker with its right edge just past it, the tail's tip just over the marker; below it, the tail on
    // top, when there's no room above on the page (a marker in a header). It stays put as the page scrolls: only the
    // document's left edge pushes it in, the tail sliding along to keep pointing. The orb's is fixed in the viewport
    // like the orb, and kept inside it.
    b.div.classList.toggle("fixed", fixed);
    const width = b.div.offsetWidth || 0;
    const height = b.div.offsetHeight || 0;
    const right = Math.min(Math.max(8 + width, x + OVERHANG), fixed ? innerWidth - 8 : Infinity);
    const above = y - r - TAIL_GAP;
    const below = above - height < 8;
    b.div.dataset.side = below ? "below" : "above";
    b.div.style.left = `${right}px`;
    b.div.style.top = `${below ? y + r + TAIL_GAP : above}px`;
    b.div.style.setProperty("--tail-right", `${tailOffset(right, x, width)}px`);
  }

  function removeBubble(sayId: string): void {
    const b = bubbles.get(sayId);
    if (b?.leave) clearTimeout(b.leave);
    b?.div.remove();
    bubbles.delete(sayId);
  }

  const bubbleOf = (threadId: string | null): BubbleView | undefined => [...bubbles.values()].find((b) => b.say.threadId === threadId);

  /** Grows the bubble back out of its marker (and cancels a pending collapse). */
  function expand(b: BubbleView): void {
    if (b.leave) { clearTimeout(b.leave); b.leave = null; }
    if (!b.collapsed) return;
    b.collapsed = false;
    b.div.classList.remove("collapsed");
    placeBubble(b);
  }

  /** Shrinks the bubble into its marker. With no marker to come back from, it's gone once shrunk. */
  function collapse(b: BubbleView): void {
    if (b.leave) { clearTimeout(b.leave); b.leave = null; }
    if (b.collapsed) return;
    b.collapsed = true;
    b.div.classList.add("collapsed");
    if (b.say.threadId !== null && !markers.has(b.say.threadId)) {
      const { sayId } = b.say;
      setTimeout(() => { if (bubbles.get(sayId) === b && b.collapsed) removeBubble(sayId); }, 300);
    }
  }

  function collapseSoon(b: BubbleView): void {
    if (b.collapsed || b.leave) return;
    b.leave = setTimeout(() => { b.leave = null; collapse(b); }, COLLAPSE_DELAY_MS);
  }

  /**
   * A spoken line: shown from its marker until the pointer leaves it (or it's clicked), then shrunk into the marker;
   * hovering the marker shows it again. A new line of the thread replaces it; it goes with its thread. Central lines
   * (threadId null) come from the orb.
   */
  function bubble(say: ThreadSay, _ended: boolean): void {
    let b = bubbles.get(say.sayId);
    if (!b) {
      // One bubble per thread: a new line replaces the previous one.
      for (const [id, other] of bubbles) if (other.say.threadId === say.threadId) removeBubble(id);
      const div = h("div", "th-bubble");
      div.setAttribute("role", "status");
      const view: BubbleView = { say, div, home: { x: scrollX + innerWidth - 16, y: scrollY + 40 }, collapsed: false, leave: null };
      div.addEventListener("pointerenter", () => expand(view));
      div.addEventListener("pointerleave", () => collapseSoon(view));
      div.addEventListener("click", () => collapse(view));
      layer.append(div);
      b = view;
      bubbles.set(say.sayId, b);
    }
    // A turn's lines share one bubble: a new line (not more words of the same one) grows it back out of its marker.
    const newLine = !say.text.startsWith(b.say.text);
    b.say = say;
    // The orb itself shows a central question (its "asking" state); a thread's marker doesn't, so its bubble does.
    b.div.classList.toggle("reply", say.needsReply && say.threadId !== null);
    b.div.replaceChildren(stripVoiceCues(say.text));
    if (newLine && b.collapsed) expand(b);
    placeBubble(b);
  }

  // ── panel ──

  function closePanel(): void {
    if (!panel) return;
    const p = panel;
    panel = null;
    p.form?.destroy();
    p.root.remove();
    const m = p.threadId === null ? undefined : markers.get(p.threadId);
    if (m) renderMarker(m);
    renderOrb();
  }

  function openPanel(threadId: string): void {
    const m = markers.get(threadId);
    if (!m) return;
    closePanel();
    const root = h("div", "th-panel");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", displayTitle(m.thread.title));
    layer.append(root);
    const queued = m.thread.state === "queued";
    const form = opts.forms.create({
      placeholder: queued ? "Add to this feedback…" : "Follow up… type, or hold Shift to talk",
      submit: (text) => followUp(threadId, text),
      escape: (empty) => { if (empty) closePanel(); else form.field.blur(); },
      openOnFocus: true,
    });
    panel = { threadId, root, form, confirming: false, openDetails: new Set(), seen: new Set(), goal: null, view: { sx: scrollX, sy: scrollY, vw: innerWidth, vh: innerHeight } };
    const b = bubbleOf(threadId);
    if (b) collapse(b);
    renderPanel();
    renderMarker(m);
    opts.send({ type: "thread.focus", threadId });
    root.querySelector<HTMLButtonElement>(".th-close")?.focus({ preventScroll: true });
  }

  /** The orb's panel: the conversation as the sidebar shows it. */
  function openCentral(): void {
    closePanel();
    const root = h("div", "th-panel");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Conversation");
    layer.append(root);
    panel = { threadId: null, root, form: null, confirming: false, openDetails: new Set(), seen: new Set(), goal: null, view: { sx: 0, sy: 0, vw: innerWidth, vh: innerHeight } };
    const b = bubbleOf(null);
    if (b) collapse(b);
    renderPanel();
    renderOrb();
    root.querySelector<HTMLButtonElement>(".th-close")?.focus({ preventScroll: true });
  }

  function placePanel(): void {
    if (!panel) return;
    const s = spotOf(panel.threadId);
    if (!s) return;
    // The orb's panel is fixed like the orb, placed against the viewport as it is now.
    const view = s.fixed ? { sx: 0, sy: 0, vw: innerWidth, vh: innerHeight } : panel.view;
    panel.root.classList.toggle("fixed", s.fixed);
    const { left, top, side, tailRight } = panelPosition(s.x, s.y, panel.root.offsetHeight || 300, view, s.r);
    panel.root.style.left = `${left}px`;
    panel.root.style.top = `${top}px`;
    panel.root.dataset.side = side;
    panel.root.style.setProperty("--tail-right", `${tailRight}px`);
  }

  function renderMessage(msg: ThreadMessage, openDetails: Set<string>): HTMLElement {
    const row = h("div", `th-msg role-${msg.role} kind-${msg.kind}`);
    const who = msg.role === "user" ? "You" : msg.role === "assistant" ? "Assistant" : "System";
    const time = new Date(msg.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    row.append(h("div", "th-meta", `${who} · ${msg.kind} · ${time}`), h("div", "th-text", msg.role === "user" ? msg.text : stripVoiceCues(msg.text)));
    if (msg.detail) {
      const d = h("details");
      d.open = openDetails.has(msg.id);
      d.addEventListener("toggle", () => { if (d.open) openDetails.add(msg.id); else openDetails.delete(msg.id); });
      d.append(h("summary", undefined, "Full answer"), h("pre", undefined, msg.detail));
      row.append(d);
    }
    if (msg.filesTouched?.length) row.append(h("div", "th-files", `Edited: ${msg.filesTouched.join(", ")}`));
    return row;
  }

  /** A conversation entry in the orb's panel: what the user said, then the reply. */
  function renderEntry(e: ConvoEntry, openDetails: Set<string>): HTMLElement {
    const row = h("div", `th-turn${e.note ? " note" : ""}`);
    if (e.user !== null) {
      const user = h("div", "th-msg role-user");
      user.append(h("div", "th-meta", ["You", ...e.badges, ...(e.note ? [e.note] : [])].join(" · ")), h("div", "th-text", e.user));
      row.append(user);
    }
    if (e.assistant || e.who || e.detail) {
      const bot = h("div", "th-msg role-assistant");
      bot.append(h("div", "th-meta", [e.who ?? "Assistant", ...(e.user === null ? e.badges : [])].join(" · ")));
      if (e.assistant) bot.append(h("div", "th-text", stripVoiceCues(e.assistant)));
      if (e.detail) {
        const d = h("details");
        d.open = openDetails.has(e.id);
        d.addEventListener("toggle", () => { if (d.open) openDetails.add(e.id); else openDetails.delete(e.id); });
        d.append(h("summary", undefined, "Full answer"), h("pre", undefined, e.detail));
        bot.append(d);
      }
      row.append(bot);
    }
    return row;
  }

  function renderPanel(): void {
    if (!panel) return;
    const p = panel;
    const t = p.threadId === null ? null : markers.get(p.threadId)?.thread;
    if (t === undefined) return closePanel();
    const scroll = p.root.querySelector(".th-body")?.scrollTop;
    const close = h("button", "th-close", "×");
    close.type = "button";
    close.title = "Close (Esc)";
    close.setAttribute("aria-label", "Close");
    close.onclick = closePanel;
    const head = h("div", "th-head");
    head.append(h("span", "th-title", t ? displayTitle(t.title) : "Conversation"));
    const stateOf: ThreadState | null = t ? t.state : orb.state === "running" ? "running" : null;
    if (stateOf && STATE_LABEL[stateOf]) {
      const state = h("span", "th-state", STATE_LABEL[stateOf]);
      state.dataset.state = stateOf;
      head.append(state);
    }
    if (t) {
      const del = h("button", "th-trash");
      del.type = "button";
      del.innerHTML = ICON_TRASH;
      del.title = t.state === "queued" ? "Delete this feedback (it won't be sent)" : "Delete this thread (its edits stay in the code)";
      del.setAttribute("aria-label", "Delete");
      del.onclick = () => { p.confirming = true; renderPanel(); p.root.querySelector<HTMLButtonElement>(".th-foot button")?.focus(); };
      head.append(del);
    }
    head.append(close);
    const body = h("div", "th-body");
    const firstRender = !p.seen.size;
    let fresh: string | null = null;
    const note = (id: string, row: HTMLElement) => {
      row.dataset.key = id;
      if (p.seen.has(id)) return;
      p.seen.add(id);
      fresh ??= id;
    };
    if (!t) {
      for (const e of entries) {
        const row = renderEntry(e, p.openDetails);
        note(e.id, row);
        body.append(row);
      }
      if (!entries.length) body.append(h("div", "th-empty", "Nothing said yet."));
      p.root.replaceChildren(head, body);
      scrollBody(p, body, scroll, firstRender, fresh);
      placePanel();
      return;
    }
    // Follow-ups queued on its element (Instant off) are their own "queued" thread: shown here too, not sent yet.
    const pending = t.state === "queued" ? [] : queuedMessages(t.anchor.domPath);
    if (t.messages.length || pending.length) {
      for (const m of t.messages) {
        const row = renderMessage(m, p.openDetails);
        note(m.id, row);
        body.append(row);
      }
      for (const m of pending) {
        const row = renderMessage(m, p.openDetails);
        note(`queued:${m.id}`, row);
        row.classList.add("queued");
        row.querySelector(".th-meta")!.textContent = "You · not sent yet";
        body.append(row);
      }
    } else body.append(h("div", "th-empty", "Nothing here yet."));

    // The footer only holds the delete confirmation (the trash button is in the header).
    const foot = h("div", "th-foot");
    if (p.confirming) {
      const yes = h("button", "th-danger", t.state === "running" ? "Stop and delete" : "Delete");
      yes.type = "button";
      yes.title = t.state === "running" ? "Stop the running task and delete this thread" : "Delete this thread";
      yes.onclick = () => { opts.send({ type: "thread.delete", threadId: t.threadId }); closePanel(); };
      const no = h("button", undefined, "Cancel");
      no.type = "button";
      no.title = "Keep this thread";
      no.onclick = () => { p.confirming = false; renderPanel(); };
      foot.append(h("span", "th-confirm", deleteConfirmText(t.state)), no, yes);
    }
    // The form stays in place (moving it would take the focus and the caret from it).
    const form = p.form!;
    const compose = form.root.parentElement ?? h("div", "th-compose");
    if (!compose.isConnected) { compose.append(form.root); p.root.append(compose); }
    for (const c of [...p.root.children]) if (c !== compose) c.remove();
    compose.before(head, ...(t.summary ? [h("div", "th-summary", stripVoiceCues(t.summary))] : []), body);
    if (p.confirming) compose.after(foot);
    scrollBody(p, body, scroll, firstRender, fresh);
    placePanel();
  }

  /** Keeps the body's scroll across a re-render; scrolls to a message that just arrived. */
  function scrollBody(p: NonNullable<typeof panel>, body: HTMLElement, scroll: number | undefined, firstRender: boolean, fresh: string | null): void {
    let goalRow: HTMLElement | null = null;
    if (scroll === undefined || firstRender) {
      body.scrollTop = body.scrollHeight;
      p.goal = null;
    } else {
      body.scrollTop = scroll;
      // A message was added (a turn spoken with the panel open): scroll so it shows, from its top if it's long.
      if (fresh) p.goal = fresh;
      goalRow = p.goal ? [...body.children].find((c) => (c as HTMLElement).dataset.key === p.goal) as HTMLElement ?? null : null;
      const top = goalRow ? Math.min(goalRow.offsetTop - body.offsetTop - 8, body.scrollHeight - body.clientHeight) : 0;
      if (goalRow && top > body.scrollTop + 1) body.scrollTo({ top, behavior: reducedMotion() ? "auto" : "smooth" });
      else p.goal = null;
    }
    // Scrolling by hand gives up the goal.
    const giveUp = () => { p.goal = null; };
    for (const type of ["wheel", "touchstart", "keydown"]) body.addEventListener(type, giveUp, { passive: true });
    body.addEventListener("scrollend", () => {
      if (!goalRow || panel !== p || !goalRow.isConnected) return;
      if (body.scrollTop + 1 >= Math.min(goalRow.offsetTop - body.offsetTop - 8, body.scrollHeight - body.clientHeight)) p.goal = null;
    });
  }

  /** Messages queued on the element at this DOM path (its "queued" thread's; the markers are this page's). */
  function queuedMessages(domPath: string): ThreadMessage[] {
    const q = [...markers.values()].find((m) => m.thread.state === "queued" && m.thread.anchor.domPath === domPath);
    return q?.thread.messages ?? [];
  }

  /** The panel's form: a comment on the thread's element (the marker stands for it), sent now or added to the list. */
  function followUp(threadId: string, text: string): void {
    const m = markers.get(threadId);
    const hit = m && opts.sampleAt(m.x - scrollX, m.y - scrollY);
    if (!hit || !panel?.form) return;
    hit.sample.t += performance.timeOrigin; // crosses the bridge as epoch ms
    opts.forms.send(text, hit.sample);
    panel.form.clear();
    panel.form.focus();
  }

  function open(threadId: string): void {
    const m = markers.get(threadId);
    if (!m) { pendingOpen = threadId; return; }
    pendingOpen = null;
    if (panel?.threadId !== threadId) openPanel(threadId);
    const y = m.y - innerHeight / 3;
    if (m.y < scrollY + 40 || m.y > scrollY + innerHeight - 80) {
      const top = Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight));
      // Placed for where the page scrolls to, not where it was.
      if (panel) { panel.view = { ...panel.view, sy: top }; placePanel(); }
      scrollTo({ top, behavior: reducedMotion() ? "auto" : "smooth" });
    }
  }

  // Esc and clicks outside the overlay close the panel.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !panel) return;
    if (panel.form && (layer.getRootNode() as ShadowRoot | Document).activeElement === panel.form.field) return; // the field's own handler
    e.preventDefault();
    e.stopPropagation();
    if (panel.confirming) { panel.confirming = false; renderPanel(); } else closePanel();
  }, true);
  window.addEventListener("pointerdown", (e) => {
    // Words typed in its form keep it open.
    if (panel && !e.composedPath().includes(host) && !panel.form?.value().trim()) closePanel();
  }, true);

  // ── the orb ──

  /** The drawing inside the orb and the state it was mounted with (the library can't change state in place). */
  let orbArt: { state: OrbState; svg: SVGSVGElement; destroy(): void } | null = null;

  function renderOrb(): void {
    if (orbArt?.state !== orb.state) {
      orbArt?.destroy();
      orbArt?.svg.remove();
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      orb.btn.append(svg);
      const m = mountOrb(svg, { ...ORB_LOOKS[orb.state], size: ORB_DOTS });
      orbArt = { state: orb.state, svg, destroy: m.destroy };
    }
    orb.btn.dataset.state = orb.state;
    orb.btn.classList.toggle("open", panel?.threadId === null);
    const label = `Conversation${orb.state === "running" ? " · working" : orb.state === "listening" ? " · listening" : orb.state === "asking" ? " · asking you something" : ""}`;
    orb.btn.dataset.tip = `${label}\nClick to see the conversation; drag to move`;
    orb.btn.title = orb.btn.dataset.tip;
    orb.btn.setAttribute("aria-label", label);
  }

  orb.btn.type = "button";
  orb.btn.addEventListener("click", () => {
    if (orb.dragged) { orb.dragged = false; return; }
    if (panel?.threadId === null) closePanel(); else openCentral();
  });
  orb.btn.addEventListener("pointerenter", () => { const b = bubbleOf(null); tipUnlessBubble(orb.btn, b); if (b && panel?.threadId !== null && !orb.drag) expand(b); });
  orb.btn.addEventListener("pointerleave", () => { const b = bubbleOf(null); if (b) collapseSoon(b); });
  orb.btn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    orb.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: e.clientX - orb.x, dy: e.clientY - orb.y, moved: false };
    orb.btn.setPointerCapture(e.pointerId);
  });
  orb.btn.addEventListener("pointermove", (e) => {
    const d = orb.drag;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DRAG_SLOP) return;
    d.moved = true;
    orb.btn.classList.add("dragging");
    orb.pos = { x: (e.clientX - d.dx) / innerWidth, y: (e.clientY - d.dy) / innerHeight };
    position();
  });
  const endDrag = (e: PointerEvent) => {
    const d = orb.drag;
    if (!d || d.id !== e.pointerId) return;
    orb.drag = null;
    orb.btn.classList.remove("dragging");
    if (orb.btn.hasPointerCapture(e.pointerId)) orb.btn.releasePointerCapture(e.pointerId);
    if (!d.moved || !orb.pos) return;
    // Stored where it's shown (clamped inside the viewport).
    orb.pos = { x: orb.x / innerWidth, y: orb.y / innerHeight };
    orb.dragged = e.type === "pointerup";
    opts.send({ type: "orb.move", pos: orb.pos });
  };
  orb.btn.addEventListener("pointerup", endDrag);
  orb.btn.addEventListener("pointercancel", endDrag);
  layer.append(orb.btn);
  renderOrb();
  opts.attach();
  position();

  function setOrb(state: OrbState, pos: OrbPos | null): void {
    orb.state = state;
    if (!orb.drag) orb.pos = pos;
    renderOrb();
    if (panel?.threadId === null) renderPanel();
    position();
  }

  function setConversation(list: ConvoEntry[]): void {
    entries = list;
    if (panel?.threadId === null) renderPanel();
  }

  return {
    setThreads,
    bubble,
    provisional,
    clearProvisional: (turnId) => { if (prov?.turnId === turnId) clearProv(); },
    open,
    setOrb,
    setConversation,
    isOrb(node) {
      if (orb.btn.contains(node)) return true;
      if (panel?.threadId === null && panel.root.contains(node)) return true;
      const b = bubbleOf(null);
      return !!b && b.div.contains(node);
    },
    anchorFor(node) {
      const elOf = (threadId: string | null) => (threadId ? markers.get(threadId)?.el ?? null : null);
      for (const m of markers.values()) if (m.btn.contains(node)) return m.el;
      for (const b of bubbles.values()) if (b.div.contains(node)) return elOf(b.say.threadId);
      if (panel && panel.threadId !== null && panel.root.contains(node)) return elOf(panel.threadId);
      return null;
    },
    queuedOn: (domPath) => queuedMessages(domPath).map((m) => m.text),
  };
}
