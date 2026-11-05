import { drawingAnchor } from "../../shared/anchor.ts";
import { drawingPreview, drawingPreviewOpen } from "./drawingPreview.ts";
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
import { talkHint, type FormHub, type InlineForm } from "./inlineForm.ts";
import type { BubbleConfirm, ConvoEntry, HeldComment, OrbPos, OrbState, PageConfirmAction, PageHeldAction, PageOrbAction, PagePanelAction, PageThreadAction } from "./pageBridge.ts";
import { mountPlasmaOrb, PLASMA_ORB_CSS, type PlasmaState } from "./plasmaOrb.ts";
import { ORB_ASKING_COLORS, ORB_COLORS, stateColors, stateColorVars, toneOfCss, type StateColor, type Tone } from "./colors.ts";

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
const ORB = 78;
const ORB_BOTTOM = 25;
/**
 * The Plasma Orb drawn in it (web/cursor/plasmaOrb.ts; pulseOrb.ts and particlesOrb.ts are the earlier ones), a little
 * smaller than the button so its glow spreads round it, one motion per state: slow plasma when idle, a swelling glow
 * while listening, fast churning while anything is being read out, a beat while the conversation or any thread is
 * working, in the logo's colours (colors.ts ORB_COLORS); idle in cyan when the last reply asked you something (ORB_ASKING_COLORS), and
 * idle in rose when the last turn failed (after shaking and flaring rose for ORB_SHAKE_MS).
 */
const ORB_ART = 70;
const ORB_SHAKE_MS = 1200;
const ORB_LOOKS: Record<OrbState, { state: PlasmaState; colors: StateColor }> = {
  idle: { state: "idle", colors: "working" },
  listening: { state: "listening", colors: "working" },
  speaking: { state: "speaking", colors: "working" },
  running: { state: "thinking", colors: "working" },
  asking: { state: "idle", colors: "asking" },
  failed: { state: "idle", colors: "failed" },
};
/** A marker's look: its thread's state, or "asking" when the thread's last reply asked you something. */
const markerLook = (t: ThreadInfo): string => (t.awaitingReply && (t.state === "idle" || t.state === "pending") ? "asking" : t.state);
/** The orb is kept this far inside the viewport. */
const ORB_MARGIN = 4;
/** A press on the orb that moves more than this is a drag, not a click. */
const DRAG_SLOP = 4;
const PANEL_WIDTH = 340;
const PANEL_GAP = 8;

const cssVars = (vars: Record<string, string>): string => Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(" ");

export const THREAD_CSS = `
.th-layer { ${cssVars(stateColorVars("dark"))} --th-edge: 0 0 0 1.5px rgba(255,255,255,.85), 0 1px 4px rgba(0,0,0,.45); position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 1; font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; color: var(--ui-text); }
/* Markers are small orbs in the shared palette (colors.ts): a white hairline and a soft shadow keep them clear on any page. */
.th-marker { position: absolute; width: ${MARKER}px; height: ${MARKER}px; margin: -${MARKER / 2}px 0 0 -${MARKER / 2}px; padding: 0; box-sizing: border-box; border-radius: 50%; border: 0; background: var(--st-working-fill); box-shadow: var(--th-edge); cursor: pointer; pointer-events: auto; z-index: 1; }
.th-marker:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }
.th-marker[data-state="running"] { animation: th-beat var(--st-beat) ease-in-out infinite; }
.th-marker[data-state="idle"], .th-marker[data-state="pending"] { background: ${CHECK} center / 10px no-repeat, var(--st-done-fill); }
.th-marker[data-state="asking"] { background: var(--st-asking-fill); }
.th-marker[data-state="failed"] { background: var(--st-failed-fill); }
.th-marker[data-state="queued"] { background: var(--st-queued-fill); opacity: .55; }
.th-marker.faded { opacity: .5; }
.th-marker.open { box-shadow: var(--th-edge), var(--st-open-ring); }
.th-orb { position: fixed; width: ${ORB}px; height: ${ORB}px; margin: -${ORB / 2}px 0 0 -${ORB / 2}px; padding: 0; display: grid; place-items: center; box-sizing: border-box; border-radius: 50%; border: 0; background: none; cursor: grab; pointer-events: auto; touch-action: none; z-index: 1; }
/* The canvas is bigger than the button (the sphere fills about 60% of it): centred on it, overflowing evenly. */
/* On a light page the palette deepens (colors.ts STATE_COLORS_ON_LIGHT). */
.th-layer[data-tone="light"] { ${cssVars(stateColorVars("light"))} }
.th-orb .pl { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); pointer-events: none; }
.th-orb:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }
.th-orb.dragging { cursor: grabbing; }
/* Waiting on you (amber): a small bounce now and then, the orb and markers alike (on the orb's button, so its canvas keeps its centring). */
.th-orb[data-state="asking"], .th-marker[data-state="asking"] { animation: th-bounce 1.8s ease-in-out infinite; }
.th-marker[data-state="asking"] { --hop: 4px; }
@keyframes th-bounce { 0%, 50%, 100% { transform: none; } 15% { transform: translateY(calc(-1 * var(--hop, 6px))); } 30% { transform: none; } 40% { transform: translateY(calc(-1 * var(--hop, 6px) / 3)); } }
.th-bubble.fixed, .th-panel.fixed { position: fixed; }
/* Drawn at release until the turn's thread is known: still the moment you spoke, so the listening ripple. */
.th-prov { position: absolute; width: ${MARKER}px; height: ${MARKER}px; margin: -${MARKER / 2}px 0 0 -${MARKER / 2}px; box-sizing: border-box; border-radius: 50%; background: var(--st-working-fill); box-shadow: var(--th-edge); animation: th-ripple 1s ease-out infinite; }
/* Working breathes at the orb's thinking beat; listening ripples outward, faster. */
@keyframes th-beat { 50% { transform: scale(.82); } }
@keyframes th-ripple { 0% { box-shadow: var(--th-edge), 0 0 0 0 color-mix(in srgb, var(--st-working-to) 60%, transparent); } 100% { box-shadow: var(--th-edge), 0 0 0 9px transparent; } }
@media (prefers-reduced-motion: reduce) {
  .th-marker[data-state="running"] { animation: none; }
  .th-orb[data-state="asking"], .th-marker[data-state="asking"] { animation: none; }
  .th-prov { animation: none; }
  .th-bubble, .th-bubble.collapsed { transition: opacity .15s linear; }
  .th-bubble.collapsed { --s: 1; }
}
/* Collapsed, the bubble shrinks into its marker: scaled about its tail's tip, which sits on the marker. */
.th-bubble { --s: 1; position: absolute; transform: translate(-100%, -100%) scale(var(--s)); transform-origin: calc(100% - var(--tail-right, 11px) - ${TAIL / 2}px) calc(100% + ${TAIL_REACH}px); max-width: 280px; width: max-content; padding: 6px 10px; box-sizing: border-box; border-radius: 12px; background: var(--ui-raised); border: 1px solid var(--ui-accent-line); box-shadow: 0 2px 10px var(--ui-shadow); white-space: pre-wrap; overflow-wrap: anywhere; pointer-events: auto; cursor: default; transition: transform .22s cubic-bezier(.2,.9,.3,1.15), opacity .18s linear; z-index: 2; }
.th-bubble.collapsed { --s: 0; opacity: 0; pointer-events: none; transition: transform .2s cubic-bezier(.5,0,.75,0), opacity .2s linear; }
.th-bubble::after, .th-panel::before { content: ""; position: absolute; right: var(--tail-right, 11px); width: ${TAIL}px; height: ${TAIL}px; box-sizing: border-box; background: inherit; border: solid var(--ui-accent-line); transform: rotate(45deg); }
.th-bubble::after { bottom: -${TAIL / 2 + 1}px; border-width: 0 1px 1px 0; }
.th-bubble[data-side="below"] { transform: translateX(-100%) scale(var(--s)); transform-origin: calc(100% - var(--tail-right, 11px) - ${TAIL / 2}px) -${TAIL_REACH}px; }
.th-bubble[data-side="below"]::after { bottom: auto; top: -${TAIL / 2 + 1}px; border-width: 1px 0 0 1px; }
.th-panel { position: absolute; width: ${PANEL_WIDTH}px; max-height: 420px; display: flex; flex-direction: column; box-sizing: border-box; background: var(--ui-panel); border: 1px solid var(--ui-line); border-radius: 10px; box-shadow: 0 8px 28px var(--ui-shadow); pointer-events: auto; z-index: 3; text-align: left; }
.th-panel::before { border-color: var(--ui-line); top: -${TAIL / 2 + 1}px; border-width: 1px 0 0 1px; }
.th-panel[data-side="above"]::before { top: auto; bottom: -${TAIL / 2 + 1}px; border-width: 0 1px 1px 0; }
.th-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px; }
.th-title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.th-state { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--ui-line); color: var(--ui-muted); }
.th-state[data-state="running"], .th-state[data-state="speaking"] { color: var(--st-working); border-color: color-mix(in srgb, var(--st-working-to) 45%, transparent); }
.th-state[data-state="pending"], .th-state[data-state="idle"] { color: var(--st-done); border-color: color-mix(in srgb, var(--st-done-to) 40%, transparent); }
.th-state[data-state="asking"] { color: var(--st-asking); border-color: color-mix(in srgb, var(--st-asking-to) 45%, transparent); }
.th-state[data-state="failed"] { color: var(--st-failed); border-color: color-mix(in srgb, var(--st-failed-to) 45%, transparent); }
.th-state[data-state="queued"] { color: var(--ui-violet); border-color: color-mix(in srgb, var(--ui-violet) 35%, transparent); }
.th-panel button { font: inherit; font-size: 12px; color: inherit; background: var(--ui-field); border: 1px solid var(--ui-line); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.th-panel button:hover { border-color: var(--ui-accent); }
.th-panel button:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 1px; }
.th-panel .th-close { padding: 0 7px; font-size: 15px; line-height: 20px; border: 0; background: transparent; color: var(--ui-muted); }
.th-panel .th-trash { display: flex; align-items: center; padding: 3px 5px; border: 0; background: transparent; color: var(--ui-muted); }
.th-panel .th-trash:hover { color: var(--ui-err-text); }
.th-summary { padding: 0 12px 8px; font-size: 12px; color: var(--ui-muted); }
.th-body { flex: 1; min-height: 0; overflow: auto; padding: 0 12px 8px; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--ui-line); padding-top: 8px; }
.th-msg { border-left: 2px solid var(--ui-line); padding-left: 8px; }
.th-msg.role-user { border-left-color: color-mix(in srgb, var(--ui-accent) 50%, transparent); }
.th-msg.role-assistant { border-left-color: color-mix(in srgb, var(--ui-ok) 50%, transparent); }
.th-msg.role-system { border-left-color: color-mix(in srgb, var(--ui-warn) 50%, transparent); }
.th-msg.kind-error { border-left-color: var(--ui-err); }
.th-meta { font: 10.5px ui-monospace, monospace; color: var(--ui-muted); }
.th-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.th-msg details summary { cursor: pointer; color: var(--ui-accent); font-size: 12px; }
.th-msg pre { margin: 4px 0 0; padding: 6px 8px; max-height: 220px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.45 ui-sans-serif, system-ui, sans-serif; background: var(--ui-sunken); border: 1px solid var(--ui-line); border-radius: 6px; }
.th-files { margin-top: 2px; font: 11px ui-monospace, monospace; color: var(--ui-ok); overflow-wrap: anywhere; }
.th-empty { color: var(--ui-muted); font-style: italic; }
.th-turn { display: flex; flex-direction: column; gap: 4px; }
.th-turn.note { opacity: .7; }
.th-msg.queued { border-left-style: dashed; border-left-color: var(--ui-violet); opacity: .85; }
.th-held { display: flex; gap: 6px; margin-top: 6px; }
.th-panel .th-held button { font-size: 11px; padding: 2px 8px; }
.th-compose { padding: 8px 12px; border-top: 1px solid var(--ui-line); }
.th-smart { display: flex; align-items: center; gap: 6px; padding: 0 12px 8px; font-size: 12px; color: var(--ui-muted); cursor: pointer; }
.th-smart input { margin: 0; accent-color: var(--ui-accent); cursor: pointer; }
.th-foot { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--ui-line); }
.th-foot .th-confirm { flex: 1; font-size: 12px; }
.th-foot .th-danger { border-color: color-mix(in srgb, var(--ui-err) 50%, transparent); color: var(--ui-err-text); }
.th-foot .th-danger:hover { border-color: var(--ui-err); }
.th-foot .spacer { flex: 1; }
/* A bubble's question (stop this task?): Yes, and No, the default, whose outline closes as the time to answer runs out. */
.th-bubble.asking { display: flex; align-items: center; gap: 10px; max-width: 400px; }
.th-ask { flex: none; display: flex; gap: 6px; white-space: normal; }
.th-ask button { position: relative; font: inherit; font-size: 12px; color: inherit; background: var(--ui-field); border: 1px solid var(--ui-line); border-radius: 6px; padding: 3px 12px; cursor: pointer; }
.th-ask button:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 1px; }
.th-ask .th-yes { border-color: color-mix(in srgb, var(--ui-err) 50%, transparent); color: var(--ui-err-text); }
.th-ask .th-yes:hover { border-color: var(--ui-err); }
.th-ask .th-no:hover { background: var(--ui-sunken); }
.th-ask .th-no svg { position: absolute; left: -1px; top: -1px; width: calc(100% + 2px); height: calc(100% + 2px); overflow: visible; pointer-events: none; }
.th-ask .th-no rect { x: 0.75px; y: 0.75px; width: calc(100% - 1.5px); height: calc(100% - 1.5px); rx: 6px; fill: none; stroke: var(--ui-accent); stroke-width: 1.5px; stroke-dasharray: 100; stroke-dashoffset: 100; animation: th-outline linear forwards; }
@keyframes th-outline { to { stroke-dashoffset: 0; } }
${PLASMA_ORB_CSS}`;

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
  send(action: PageThreadAction | PageOrbAction | PagePanelAction | PageConfirmAction | PageHeldAction): void;
  /** The page element at a viewport point, as a sample (a marker stands for its thread's element). */
  sampleAt(x: number, y: number): { sample: CursorSample } | null;
  /** The panel's form, its dictation, and sending (web/cursor/inlineForm.ts). */
  forms: FormHub;
  now?: () => number;
}

export interface ThreadOverlay {
  setThreads(threads: ThreadInfo[]): void;
  bubble(say: ThreadSay, ended: boolean, confirm?: BubbleConfirm): void;
  provisional(turnId: string, anchor?: ThreadAnchor): void;
  clearProvisional(turnId: string): void;
  /** Open a thread's panel and scroll its element into view (from the sidebar's list). */
  open(threadId: string): void;
  /** The orb's state, and where it was dragged to (null: bottom center). */
  setOrb(state: OrbState, pos: OrbPos | null): void;
  /** The conversation shown in the orb's panel. */
  setConversation(entries: ConvoEntry[]): void;
  /** Comments typed in a thread's panel that wait for the current turn to end. */
  setHeld(items: HeldComment[]): void;
  /** Debugging → Details: show each answer's "Full answer" and its edited files in the panel (off until the sidebar says otherwise). */
  setDetails(on: boolean): void;
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
  if (a.kind === "drawing" && !a.selector) return null;
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
/** `asking`: it holds a question (Yes / No): it stays out until answered. */
interface BubbleView {
  say: ThreadSay; div: HTMLElement; home: { x: number; y: number };
  collapsed: boolean; leave: ReturnType<typeof setTimeout> | null; asking: boolean;
}

const SVG_NS = "http://www.w3.org/2000/svg";

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
    anchor?: ThreadAnchor; turnId: string; el: Element | null; div: HTMLElement; x: number; y: number;
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
  let held: HeldComment[] = [];
  /** Debugging → Details: answers show their "Full answer" and the files they edited. */
  let details = false;

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
    if (prov?.anchor) prov.el = resolveAnchor(prov.anchor, prov.el);
    else if (prov?.el && !prov.el.isConnected) prov.el = null;
    position();
  }

  function placeOrb(): void {
    ({ x: orb.x, y: orb.y } = orbPoint(orb.pos, innerWidth, innerHeight));
    orb.btn.style.left = `${orb.x}px`;
    orb.btn.style.top = `${orb.y}px`;
    setTone(pageToneAt(orb.x, orb.y));
  }

  /**
   * Whether the page behind (x, y) (viewport coords) is light or dark: the first element under it, ours aside, with a
   * mostly opaque background colour; else the root's or the body's; else light (the browser's default white).
   */
  function pageToneAt(x: number, y: number): Tone {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === host) continue;
      const t = toneOfCss(getComputedStyle(el).backgroundColor);
      if (t) return t;
    }
    for (const el of [document.body, document.documentElement]) {
      const t = el && toneOfCss(getComputedStyle(el).backgroundColor);
      if (t) return t;
    }
    return "light";
  }

  /** The page's tone, behind the orb: the whole overlay (orb and markers) takes its palette from it. */
  let tone: Tone | null = null;
  function setTone(next: Tone): void {
    if (next === tone) return;
    tone = next;
    layer.dataset.tone = next;
    orbDrawn = null; // recolour the orb
    renderOrb();
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
      m.faded = !live && m.thread.anchor.kind !== "drawing";
      m.btn.classList.toggle("faded", m.faded);
      m.btn.style.left = `${m.x}px`;
      m.btn.style.top = `${m.y}px`;
    }
    if (prov) {
      const r = prov.el ? docRect(prov.el) : prov.bounds;
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
  setInterval(() => {
    if (markers.size || prov) resolveAll(); else opts.attach();
    setTone(pageToneAt(orb.x, orb.y)); // the page can turn light or dark without a scroll (a theme switch)
  }, RESOLVE_EVERY_MS);

  // ── markers ──

  function renderMarker(m: MarkerView): void {
    const t = m.thread;
    const look = markerLook(t);
    m.btn.dataset.state = look;
    m.btn.classList.toggle("open", panel?.threadId === t.threadId);
    const label = [displayTitle(t.title), look === "asking" ? "asking you" : STATE_LABEL[t.state], t.unread ? "unread" : ""].filter(Boolean).join(" · ");
    // No native tooltip: hovering a marker grows its bubble out instead.
    m.btn.setAttribute("aria-label", t.summary ? `${label}. ${stripVoiceCues(t.summary)}` : label);
  }

  /**
   * Hovering the orb when it has a bubble grows the bubble out: no tooltip on top of it. Overlay tooltips are `data-tip`
   * (drawn by electron/tooltip.ts), never `title`, so Chromium doesn't draw its own as well.
   */
  function tipUnlessBubble(btn: HTMLElement, b: BubbleView | undefined): void {
    btn.dataset.tip = b ? "" : btn.dataset.tipText ?? "";
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
    for (let t of threads) {
      if (t.anchor.kind === "drawing" && !t.anchor.selector) {
        const annotation = t.messages.find(m => m.annotation)?.annotation;
        const anchor = annotation && drawingAnchor(annotation);
        if (anchor?.selector) t = { ...t, anchor };
      }
      let m = markers.get(t.threadId);
      if (!m) {
        const btn = h("button", "th-marker");
        btn.type = "button";
        btn.addEventListener("mousedown", (e) => e.preventDefault()); // as the orb: no focus ring after a click and Shift
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

  function provisional(turnId: string, anchor?: ThreadAnchor): void {
    clearProv();
    const div = h("div", "th-prov");
    div.setAttribute("aria-hidden", "true");
    layer.append(div);
    const el = anchor ? resolveAnchor(anchor, null) : opts.pointed();
    prov = { anchor, turnId, el, div, x: 0, y: 0, bounds: anchor?.bounds ?? (el && docRect(el)), point: anchor?.point ?? opts.pointer?.() ?? null };
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

  /** Leaving it or its marker: a question stays out (it waits for an answer). */
  function collapseSoon(b: BubbleView): void {
    if (b.collapsed || b.leave || b.asking) return;
    b.leave = setTimeout(() => { b.leave = null; collapse(b); }, COLLAPSE_DELAY_MS);
  }

  /**
   * A question's Yes / No. No is the default: its outline closes over `ms`, and then the bubble goes as a No. Either
   * answer removes the bubble; a new line of the thread replacing it first means no answer at all.
   */
  function askRow(sayId: string, c: BubbleConfirm): HTMLElement {
    const answer = (yes: boolean) => {
      if (!bubbles.has(sayId)) return;
      removeBubble(sayId);
      opts.send({ type: "bubble.answer", confirmId: c.confirmId, yes });
    };
    const yes = h("button", "th-yes", "Yes");
    yes.type = "button";
    yes.onclick = () => answer(true);
    const no = h("button", "th-no", "No");
    no.type = "button";
    no.dataset.tip = "Keep it running (what happens when the outline closes)";
    no.onclick = () => answer(false);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("aria-hidden", "true");
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("pathLength", "100");
    rect.style.animationDuration = `${c.ms}ms`;
    rect.addEventListener("animationend", () => answer(false));
    svg.append(rect);
    no.append(svg);
    const row = h("div", "th-ask");
    row.append(yes, no);
    return row;
  }

  /**
   * A spoken line: shown from its marker until the pointer leaves it (or it's clicked), then shrunk into the marker;
   * hovering the marker shows it again. A new line of the thread replaces it; it goes with its thread. Central lines
   * (threadId null) come from the orb. With `confirm` it's a question instead (BubbleConfirm): it stays out, with
   * Yes / No under the text, until answered or replaced.
   */
  function bubble(say: ThreadSay, _ended: boolean, confirm?: BubbleConfirm): void {
    let b = bubbles.get(say.sayId);
    if (!b) {
      // One bubble per thread: a new line replaces the previous one.
      for (const [id, other] of bubbles) if (other.say.threadId === say.threadId) removeBubble(id);
      const div = h("div", "th-bubble");
      div.setAttribute("role", "status");
      const view: BubbleView = { say, div, home: { x: scrollX + innerWidth - 16, y: scrollY + 40 }, collapsed: false, leave: null, asking: false };
      div.addEventListener("pointerenter", () => expand(view));
      div.addEventListener("pointerleave", () => collapseSoon(view));
      div.addEventListener("click", () => { if (!view.asking) collapse(view); });
      layer.append(div);
      b = view;
      bubbles.set(say.sayId, b);
    }
    // A turn's lines share one bubble: a new line (not more words of the same one) grows it back out of its marker.
    const newLine = !say.text.startsWith(b.say.text);
    b.say = say;
    b.div.replaceChildren(stripVoiceCues(say.text));
    b.asking = !!confirm;
    b.div.classList.toggle("asking", b.asking);
    // The question and its Yes / No on one line.
    if (confirm) b.div.append(askRow(say.sayId, confirm));
    if ((newLine || confirm) && b.collapsed) expand(b);
    placeBubble(b);
  }

  // ── panel ──

  function closePanel(): void {
    if (!panel) return;
    const p = panel;
    panel = null;
    p.form?.destroy();
    p.root.remove();
    if (p.threadId !== null) opts.send({ type: "thread.panel", threadId: null });
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
      placeholder: queued ? "Add to this feedback…" : `Follow up… type, or ${talkHint()} to talk`,
      submit: (text) => followUp(threadId, text),
      escape: (empty) => { if (empty) closePanel(); else form.field.blur(); },
      // Open while the panel is: the panel is the focus, so talking dictates into it whether or not the field has focus.
      activateOnCreate: true,
    });
    panel = { threadId, root, form, confirming: false, openDetails: new Set(), seen: new Set(), goal: null, view: { sx: scrollX, sy: scrollY, vw: innerWidth, vh: innerHeight } };
    const b = bubbleOf(threadId);
    if (b) collapse(b);
    renderPanel();
    renderMarker(m);
    opts.send({ type: "thread.focus", threadId });
    opts.send({ type: "thread.panel", threadId });
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
    if (msg.annotation) row.append(drawingPreview(msg.annotation));
    if (msg.detail && details) {
      const d = h("details");
      d.open = openDetails.has(msg.id);
      d.addEventListener("toggle", () => { if (d.open) openDetails.add(msg.id); else openDetails.delete(msg.id); });
      d.append(h("summary", undefined, "Full answer"), h("pre", undefined, msg.detail));
      row.append(d);
    }
    if (msg.filesTouched?.length && details) row.append(h("div", "th-files", `Edited: ${msg.filesTouched.join(", ")}`));
    return row;
  }

  /** A waiting comment's buttons (the sidebar acts on them). */
  function heldActions(turnId: string): HTMLElement {
    const now = h("button", undefined, "Interrupt and send");
    now.type = "button";
    now.dataset.tip = "Stop the current turn and send this comment now";
    now.onclick = () => opts.send({ type: "held.send", turnId });
    const remove = h("button", undefined, "Remove");
    remove.type = "button";
    remove.dataset.tip = "Drop this comment without sending it";
    remove.onclick = () => opts.send({ type: "held.remove", turnId });
    const row = h("div", "th-held");
    row.append(now, remove);
    return row;
  }

  /** A conversation entry in the orb's panel: what the user said, then the reply. */
  function renderEntry(e: ConvoEntry, openDetails: Set<string>): HTMLElement {
    const row = h("div", `th-turn${e.note ? " note" : ""}`);
    if (e.user !== null) {
      const user = h("div", "th-msg role-user");
      user.append(h("div", "th-meta", ["You", ...e.badges, ...(e.note ? [e.note] : [])].join(" · ")), h("div", "th-text", e.user));
      if (e.annotation) user.append(drawingPreview(e.annotation));
      if (e.held) user.append(heldActions(e.id));
      row.append(user);
    }
    if (e.assistant || e.who || (e.detail && details)) {
      const bot = h("div", "th-msg role-assistant");
      bot.append(h("div", "th-meta", [e.who ?? "Assistant", ...(e.user === null ? e.badges : [])].join(" · ")));
      if (e.assistant) bot.append(h("div", "th-text", stripVoiceCues(e.assistant)));
      if (e.detail && details) {
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
    close.dataset.tip = "Close (Esc)";
    close.setAttribute("aria-label", "Close");
    close.onclick = closePanel;
    const head = h("div", "th-head");
    head.append(h("span", "th-title", t ? displayTitle(t.title) : "Conversation"));
    const look = t ? markerLook(t) : orb.state;
    const chip = look === "asking" ? "asking you" : look === "running" ? "working" : look === "speaking" ? "speaking" : look === "failed" ? "failed" : t ? STATE_LABEL[t.state] : "";
    if (chip) {
      const state = h("span", "th-state", chip);
      state.dataset.state = look;
      head.append(state);
    }
    if (t) {
      const del = h("button", "th-trash");
      del.type = "button";
      del.innerHTML = ICON_TRASH;
      del.dataset.tip = t.state === "queued" ? "Delete this feedback (it won't be sent)" : "Delete this thread (its edits stay in the code)";
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
    const waiting = held.filter((c) => c.threadId === t.threadId);
    if (t.messages.length || pending.length || waiting.length) {
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
      // Typed here while a turn was still going: sent when it ends.
      for (const c of waiting) {
        const row = h("div", "th-msg role-user queued");
        row.append(h("div", "th-meta", "You · queued · sends when the current turn ends"), h("div", "th-text", c.text), heldActions(c.turnId));
        note(`held:${c.turnId}`, row);
        body.append(row);
      }
    } else body.append(h("div", "th-empty", "Nothing here yet."));

    // The delete confirmation, right below the header's trash button.
    const foot = h("div", "th-foot");
    if (p.confirming) {
      const yes = h("button", "th-danger", t.state === "running" ? "Stop and delete" : "Delete");
      yes.type = "button";
      yes.dataset.tip = t.state === "running" ? "Stop the running task and delete this thread" : "Delete this thread";
      yes.onclick = () => { opts.send({ type: "thread.delete", threadId: t.threadId }); closePanel(); };
      const no = h("button", undefined, "Cancel");
      no.type = "button";
      no.dataset.tip = "Keep this thread";
      no.onclick = () => { p.confirming = false; renderPanel(); };
      foot.append(h("span", "th-confirm", deleteConfirmText(t.state)), no, yes);
    }
    // "Always use the smart model": the router only speaks for it (a spoken turn), a typed one goes straight to it.
    const smart = h("label", "th-smart");
    if (t.state !== "queued") {
      const box = h("input");
      box.type = "checkbox";
      box.checked = !!t.alwaysSmart;
      box.onchange = () => opts.send({ type: "thread.smart", threadId: t.threadId, on: box.checked });
      smart.dataset.tip = "Everything you say or type here is done by the smart model. Spoken requests still get a quick spoken reply first.";
      smart.append(box, "Always use the smart model");
    }
    // The form stays in place (moving it would take the focus and the caret from it).
    const form = p.form!;
    const compose = form.root.parentElement ?? h("div", "th-compose");
    if (!compose.isConnected) { compose.append(form.root); p.root.append(compose); }
    for (const c of [...p.root.children]) if (c !== compose) c.remove();
    compose.before(head, ...(p.confirming ? [foot] : []), ...(t.summary ? [h("div", "th-summary", stripVoiceCues(t.summary))] : []), body);
    if (smart.childElementCount) compose.after(smart);
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

  /**
   * The panel's form: a comment on the thread's element (the marker stands for it), for this thread whatever the router
   * would pick. Feedback not sent yet (Instant off) isn't on the server: what's typed there joins the list.
   */
  function followUp(threadId: string, text: string): void {
    const m = markers.get(threadId);
    const hit = m && opts.sampleAt(m.x - scrollX, m.y - scrollY);
    if (!hit || !panel?.form) return;
    hit.sample.t += performance.timeOrigin; // crosses the bridge as epoch ms
    opts.forms.send(text, hit.sample, m.thread.state === "queued" ? undefined : threadId);
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
    if (e.key !== "Escape" || !panel || drawingPreviewOpen()) return;
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

  const orbArt = mountPlasmaOrb({ size: ORB_ART });
  orb.btn.append(orbArt.el);

  /** The state the orb was last drawn in, and the timer ending a failure's shake. */
  let orbDrawn: OrbState | null = null;
  let orbShake: ReturnType<typeof setTimeout> | null = null;

  function renderOrb(): void {
    if (orb.state !== orbDrawn) {
      const look = ORB_LOOKS[orb.state];
      if (orbShake) { clearTimeout(orbShake); orbShake = null; }
      // A failure shakes and flares (the orb's error look), then settles to idle in the failed colours.
      if (orb.state === "failed") {
        orbArt.setState("error");
        orbShake = setTimeout(() => { orbShake = null; orbArt.setState(look.state); }, ORB_SHAKE_MS);
      } else orbArt.setState(look.state);
      // Its own looks are the logo's six colours, asking is cyan (amber is for the markers); failed keeps its rose.
      const colors = stateColors(tone ?? "light")[look.colors];
      orbArt.setColors(look.colors === "working" ? ORB_COLORS : look.colors === "asking" ? ORB_ASKING_COLORS : [colors.from, colors.to]);
      orbDrawn = orb.state;
    }
    orb.btn.dataset.state = orb.state;
    orb.btn.classList.toggle("open", panel?.threadId === null);
    const ORB_LABEL: Record<OrbState, string> = { idle: "", listening: " · listening", speaking: " · speaking", running: " · working", asking: " · asking you something", failed: " · the last turn failed" };
    const label = `Conversation${ORB_LABEL[orb.state]}`;
    orb.btn.dataset.tipText = `${label}\nClick to see the conversation; drag to move`;
    orb.btn.dataset.tip = orb.btn.dataset.tipText;
    orb.btn.setAttribute("aria-label", label);
  }

  orb.btn.type = "button";
  // A press doesn't focus the orb (Tab still does): focused, the next key (Shift to talk) would draw its focus ring.
  orb.btn.addEventListener("mousedown", (e) => e.preventDefault());
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

  function setHeld(items: HeldComment[]): void {
    held = items;
    if (panel?.threadId) renderPanel();
  }

  function setDetails(on: boolean): void {
    if (on === details) return;
    details = on;
    if (panel) renderPanel();
  }

  return {
    setThreads,
    bubble,
    provisional,
    clearProvisional: (turnId) => { if (prov?.turnId === turnId) clearProv(); },
    open,
    setOrb,
    setConversation,
    setHeld,
    setDetails,
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
