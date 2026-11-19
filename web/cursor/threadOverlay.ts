import { drawingAnchor } from "../../shared/anchor.ts";
import { drawingPreviewOpen } from "./drawingPreview.ts";
// Element threads on the page (docs/PLAN-threads.md). The page owns each marker, its speech bubbles and the
// provisional marker drawn at release. The marker follows the original point within its element. In Electron,
// its thread panel lives in a sibling view and gets the marker's viewport coordinates from this overlay.
// The page overlay sits at document (0,0) inside the preload's closed shadow root.
// Elements are re-resolved on scroll, resize, DOM mutation (HMR included): selector → role + text → the anchor's
// last bounds (drawn faded). The conversation orb stands for the page as a whole: the central conversation's bubbles
// come from it and its panel shows the conversation. It sits fixed in the viewport, bottom center until dragged.
import { displayTitle, type ThreadAnchor, type ThreadInfo, type ThreadMessage, type ThreadSay } from "../../shared/threads.ts";
import { stripVoiceCues } from "../../shared/cues.ts";
import type { CursorSample } from "../../shared/protocol.ts";
import type { FormHub } from "./inlineForm.ts";
import type { BubbleConfirm, ConvoEntry, HeldComment, OrbPos, OrbState, PageChangesStatus, PageConfirmAction, PageHeldAction, PageOrbAction, PagePanelAction, PageThreadAction, PageThreadDeletePreview, PageThreads } from "./pageBridge.ts";
import { mountPlasmaOrb, PLASMA_ORB_CSS, type PlasmaState } from "./plasmaOrb.ts";
import { ORB_ASKING_COLORS, ORB_COLORS, stateColors, stateColorVars, toneOfCss, type StateColor, type Tone } from "./colors.ts";
import type { HarnessSessionInfo } from "../../shared/harnessSession.ts";
import { SESSION_BADGE_CSS } from "../sessionBadge.ts";
import { MARKDOWN_CSS } from "./markdown.ts";
import { element as h } from "../common.ts";
import { createThreadPanels, markerLook, askingLabel, STATE_LABEL, type PanelSnapshot } from "./threadPanel.ts";
import { MARKER, OVERHANG, TAIL, TAIL_REACH, TAIL_GAP, PANEL_WIDTH, PANEL_HEIGHT, tailOffset, markerPoint, type Spot, type MarkerGeometry } from "./threadLayout.ts";

export { markerPoint, panelPosition } from "./threadLayout.ts";
export { STATE_LABEL, deleteConfirmation } from "./threadPanel.ts";

/** Markers of threads on one element sit side by side, this far apart. */
const MARKER_STEP = 24;
const RESOLVE_THROTTLE_MS = 250;
/** Layout can change without a mutation (transitions, fonts): re-resolve this often while markers are shown. */
const RESOLVE_EVERY_MS = 1000;
/** Leaving the bubble or its marker collapses the bubble after this long (time to cross the gap between them). */
const COLLAPSE_DELAY_MS = 180;
/** White check on a done marker. */
const CHECK = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 6.2l2.3 2.3 4.7-5' fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`;
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
/** The orb is kept this far inside the viewport. */
const ORB_MARGIN = 4;
/** A press on the orb that moves more than this is a drag, not a click. */
const DRAG_SLOP = 4;
const cssVars = (vars: Record<string, string>): string => Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(" ");

export const THREAD_CSS = `
${SESSION_BADGE_CSS}
${MARKDOWN_CSS}
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
.th-panel { position: absolute; width: ${PANEL_WIDTH}px; max-height: ${PANEL_HEIGHT}px; display: flex; flex-direction: column; box-sizing: border-box; background: var(--ui-panel); border: 1px solid var(--ui-line); border-radius: 10px; box-shadow: 0 8px 28px var(--ui-shadow); pointer-events: auto; z-index: 3; text-align: left; }
.th-panel > :not(.th-body) { flex-shrink: 0; }
.th-panel.resizing, .th-panel.dragging { user-select: none; }
.th-resize { position: absolute; inset: 0; pointer-events: none; }
.th-panel .th-resize-handle { position: absolute; width: 14px; height: 14px; padding: 0; border: 0; border-radius: 4px; background: transparent; pointer-events: auto; touch-action: none; opacity: .4; }
.th-panel .th-resize-handle:hover, .th-panel .th-resize-handle:focus-visible { opacity: 1; }
.th-resize-handle::after { content: ""; position: absolute; inset: 4px; border: solid var(--ui-muted); border-width: 0 1.5px 1.5px 0; }
.th-resize-handle[data-corner="se"] { right: 0; bottom: 0; cursor: nwse-resize; }
.th-resize-handle[data-corner="sw"] { left: 0; bottom: 0; cursor: nesw-resize; }
.th-resize-handle[data-corner="sw"]::after { transform: rotate(90deg); }
.th-panel::before { border-color: var(--ui-line); top: -${TAIL / 2 + 1}px; border-width: 1px 0 0 1px; }
.th-panel[data-side="above"]::before { top: auto; bottom: -${TAIL / 2 + 1}px; border-width: 0 1px 1px 0; }
.th-panel.detached::before { display: none; }
.th-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px; cursor: grab; touch-action: none; user-select: none; }
.th-panel.dragging .th-head { cursor: grabbing; }
.th-session-row { display: flex; align-items: flex-start; gap: 8px; padding: 0 12px 8px; }
.th-session-row .session-info { flex: 1; padding: 0; }
.th-session-row > :not(.session-info) { margin-top: 2px; }
.th-title { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.th-state { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--ui-line); color: var(--ui-muted); }
.th-state[data-state="running"], .th-state[data-state="speaking"] { color: var(--st-working); border-color: color-mix(in srgb, var(--st-working-to) 45%, transparent); }
.th-state[data-state="pending"], .th-state[data-state="idle"] { color: var(--st-done); border-color: color-mix(in srgb, var(--st-done-to) 40%, transparent); }
.th-state[data-state="asking"] { color: var(--st-asking); border-color: color-mix(in srgb, var(--st-asking-to) 45%, transparent); }
.th-state[data-state="failed"] { color: var(--st-failed); border-color: color-mix(in srgb, var(--st-failed-to) 45%, transparent); }
.th-state[data-state="queued"] { color: var(--ui-violet); border-color: color-mix(in srgb, var(--ui-violet) 35%, transparent); }
.th-panel button { font: inherit; font-size: 12px; color: inherit; background: var(--ui-field); border: 1px solid var(--ui-line); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.th-panel button:hover { border-color: var(--ui-accent); }
.th-panel button:disabled { opacity: .6; cursor: default; }
.th-panel button:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 1px; }
.th-panel .th-close { padding: 0 7px; font-size: 15px; line-height: 20px; border: 0; background: transparent; color: var(--ui-muted); }
.th-panel .th-trash, .th-panel .th-stop { display: flex; align-items: center; padding: 3px 5px; border: 0; background: transparent; color: var(--ui-muted); }
.th-panel .th-trash:hover { color: var(--ui-err-text); }
.th-panel .th-stop { color: var(--ui-err-text); }
.th-panel .th-stop:hover { background: var(--ui-hover); }
.th-panel .th-commit { padding: 3px 5px; border: 0; background: transparent; color: var(--ui-accent); }
.th-panel .th-commit:not(:disabled):hover { background: var(--ui-hover); }
.th-panel .th-commit:disabled { color: var(--ui-muted); }
.th-summary { padding: 0 12px 8px; font-size: 12px; color: var(--ui-muted); }
.th-body { flex: 1; min-height: 0; overflow: auto; padding: 0 12px 8px; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--ui-line); padding-top: 8px; }
.th-msg { border-left: 2px solid var(--ui-line); padding-left: 8px; }
.th-msg.role-user { border-left-color: color-mix(in srgb, var(--ui-accent) 50%, transparent); }
.th-msg.role-assistant { border-left-color: color-mix(in srgb, var(--ui-ok) 50%, transparent); }
.th-msg.role-system { border-left-color: color-mix(in srgb, var(--ui-warn) 50%, transparent); }
.th-msg.kind-error { border-left-color: var(--ui-err); }
.th-meta { font: 10.5px ui-monospace, monospace; color: var(--ui-muted); }
.th-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.th-text.md { white-space: normal; }
.th-msg details summary { cursor: pointer; color: var(--ui-accent); font-size: 12px; }
.th-msg .th-detail { margin: 4px 0 0; padding: 6px 8px; max-height: 220px; overflow: auto; font: 12px/1.45 ui-sans-serif, system-ui, sans-serif; background: var(--ui-raised); border: 1px solid var(--ui-line); border-radius: 6px; }
.th-files { margin-top: 2px; font: 11px ui-monospace, monospace; color: var(--ui-ok); overflow-wrap: anywhere; }
.th-empty { color: var(--ui-muted); font-style: italic; }
.th-turn { display: flex; flex-direction: column; gap: 4px; }
.th-turn.note { opacity: .7; }
.th-msg.queued { border-left-style: dashed; border-left-color: var(--ui-violet); opacity: .85; }
.th-held { display: flex; gap: 6px; margin-top: 6px; }
.th-panel .th-held button { font-size: 11px; padding: 2px 8px; }
.th-compose { padding: 8px 12px; border-top: 1px solid var(--ui-line); }
.th-compose[inert] { opacity: .6; }
.th-smart { display: flex; align-items: center; gap: 6px; padding: 0 12px 8px; font-size: 12px; color: var(--ui-muted); cursor: pointer; }
.th-smart input { margin: 0; accent-color: var(--ui-accent); cursor: pointer; }
.th-foot { display: flex; flex-direction: column; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--ui-line); }
.th-foot .th-confirm { font-size: 12px; }
.th-delete-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
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
  external?: {
    open(id: string, geometry: MarkerGeometry, sample?: CursorSample): void;
    position(id: string, geometry: MarkerGeometry): void;
    close(id: string): void;
    outside(id: string): void;
  };
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
  sampleAt(x: number, y: number, element?: Element | null): { sample: CursorSample } | null;
  /** The panel's form, its dictation, and sending (web/cursor/inlineForm.ts). */
  forms: FormHub;
  /** Native clipboard, including on pages whose origin cannot use navigator.clipboard. */
  copyText?(text: string): Promise<void>;
  releaseSession?(sessionId: string): Promise<void>;
  continueSession?(sessionId: string, context?: string): Promise<void>;
  now?: () => number;
}

export interface ThreadOverlay {
  trackPanel(id: string | null): void;
  snapshot(): PanelSnapshot | null;
  restore(saved: PanelSnapshot): void;
  setThreads(update: PageThreads): void;
  showDeletePreview(result: PageThreadDeletePreview): void;
  setChangesStatus(status: PageChangesStatus, enabled: boolean): void;
  bubble(say: ThreadSay, ended: boolean, confirm?: BubbleConfirm): void;
  provisional(turnId: string, anchor?: ThreadAnchor): void;
  clearProvisional(turnId: string): void;
  /** Open a thread's panel and scroll its element into view (from the sidebar's list). */
  open(threadId: string): void;
  /** The orb's state, and where it was dragged to (null: bottom center). */
  setOrb(state: OrbState, pos: OrbPos | null): void;
  /** The conversation shown in the orb's panel. */
  setConversation(entries: ConvoEntry[], session?: HarnessSessionInfo | null): void;
  /** Comments typed in a thread's panel that wait for the current turn to end. */
  setHeld(items: HeldComment[]): void;
  /** Debugging → Details: edited files (off until enabled). */
  setDetails(on: boolean): void;
  /** General preferences → Solver session: native session / resume command (off until enabled). */
  setSession(on: boolean): void;
  /** Debugging → Full answers: expandable written answers (on by default). */
  setFullAnswers(on: boolean): void;
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
/** `home`: where the bubble points with no marker (the viewport's top-right when it appeared). */
/** `collapsed`: shrunk into its marker (hovering the marker grows it back out). `leave`: the pending collapse. */
/** `asking`: it holds a question (Yes / No): it stays out until answered. */
interface BubbleView {
  say: ThreadSay; div: HTMLElement; home: { x: number; y: number };
  collapsed: boolean; leave: ReturnType<typeof setTimeout> | null; asking: boolean;
}

const SVG_NS = "http://www.w3.org/2000/svg";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  /** Asked to open before the thread arrived. */
  let pendingOpen: string | null = null;
  /** The orb: `x`, `y` its center in viewport coords. `drag`: a press on it, a drag once it moved past DRAG_SLOP. */
  const orb = {
    btn: h("button", "th-orb"), state: "idle" as OrbState, pos: null as OrbPos | null, x: 0, y: 0,
    drag: null as { id: number; x0: number; y0: number; dx: number; dy: number; moved: boolean } | null,
    /** The click that ends a drag doesn't open the panel. */
    dragged: false,
  };
  let externalId: string | null = null;
  const panels = createThreadPanels({
    ...opts, thread: id => markers.get(id)?.thread, spot: spotOf, queued: queuedMessages, orbState: () => orb.state,
    submit(id, text) {
      const m = markers.get(id);
      const hit = m && opts.sampleAt(m.x - scrollX, m.y - scrollY);
      if (!hit) return false;
      hit.sample.t += performance.timeOrigin;
      opts.forms.send(text, hit.sample, m.thread.state === "queued" ? undefined : id);
      return true;
    },
    changed: refreshSelection,
  });
  const selected = () => externalId ?? panels.current?.threadId;
  function refreshSelection() {
    const b = bubbleOf(selected() ?? null);
    if (b && selected() !== undefined) collapse(b);
    for (const m of markers.values()) renderMarker(m);
    renderOrb();
  }
  function closePanel() {
    if (externalId) opts.external?.close(externalId);
    panels.close();
  }
  function openPanel(id: string) {
    if (!opts.external) return panels.open(id);
    panels.close();
    const m = markers.get(id);
    if (m) opts.external.open(id, geometry(m), opts.sampleAt(m.x - scrollX, m.y - scrollY, m.el)?.sample);
  }
  function openCentral() {
    if (externalId) opts.external?.close(externalId);
    panels.central();
  }
  function geometry(m: MarkerView): MarkerGeometry {
    return { x: m.x - scrollX, y: m.y - scrollY, radius: MARKER / 2, vw: innerWidth, vh: innerHeight,
      scrollX, scrollY, tone: tone ?? "light", resolved: !m.faded };
  }
  window.addEventListener("pointerdown", e => {
    if (e.composedPath().includes(host)) return;
    if (externalId) opts.external?.outside(externalId);
    if (panels.current && !panels.current.form?.value().trim()) panels.close();
  }, true);
  window.addEventListener("keydown", e => {
    if (externalId && e.key === "Escape" && !drawingPreviewOpen()) opts.external?.close(externalId);
  }, true);

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
    panels.position();
    const tracked = externalId && markers.get(externalId);
    if (tracked) opts.external?.position(tracked.thread.threadId, geometry(tracked));
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
    m.btn.classList.toggle("open", selected() === t.threadId);
    const label = [displayTitle(t.title), look === "asking" ? askingLabel(t) : STATE_LABEL[t.state], t.unread ? "unread" : ""].filter(Boolean).join(" · ");
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

  function setThreads(update: PageThreads): void {
    const { threads, loading } = update;
    panels.setThreadActions(update);
    const ids = new Set(threads.map((t) => t.threadId));
    for (const [id, m] of markers) {
      if (ids.has(id) || loading) continue;
      m.btn.remove();
      markers.delete(id);
      panels.forgetSize(id);
      for (const [sayId, b] of bubbles) if (b.say.threadId === id) removeBubble(sayId);
      if (panels.current?.threadId === id) panels.close();
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
        btn.addEventListener("click", () => (selected() === t.threadId ? closePanel() : openPanel(t.threadId)));
        btn.addEventListener("pointerenter", () => { const b = bubbleOf(t.threadId); if (b && selected() !== t.threadId) expand(b); });
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
    panels.render();
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

  /** Messages queued on the element at this DOM path (its "queued" thread's; the markers are this page's). */
  function queuedMessages(domPath: string): ThreadMessage[] {
    const q = [...markers.values()].find((m) => m.thread.state === "queued" && m.thread.anchor.domPath === domPath);
    return q?.thread.messages ?? [];
  }

  function open(threadId: string): void {
    const m = markers.get(threadId);
    if (!m) { pendingOpen = threadId; return; }
    pendingOpen = null;
    if (selected() !== threadId) openPanel(threadId);
    const y = m.y - innerHeight / 3;
    if (m.y < scrollY + 40 || m.y > scrollY + innerHeight - 80) {
      const top = Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight));
      // Placed for where the page scrolls to, not where it was.
      if (panels.current) { panels.current.view.sy = top; panels.position(); }
      scrollTo({ top, behavior: reducedMotion() ? "auto" : "smooth" });
    }
  }

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
    orb.btn.classList.toggle("open", selected() === null);
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
    if (selected() === null) closePanel(); else openCentral();
  });
  orb.btn.addEventListener("pointerenter", () => { const b = bubbleOf(null); tipUnlessBubble(orb.btn, b); if (b && selected() !== null && !orb.drag) expand(b); });
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
    if (selected() === null) panels.render();
    position();
  }

  return {
    snapshot: panels.snapshot,
    restore(saved) { if (!pendingOpen) panels.restore(saved); },
    trackPanel(id) {
      externalId = id;
      if (id) panels.close();
      refreshSelection();
      position();
    },
    setThreads,
    showDeletePreview: panels.showDeletePreview,
    setChangesStatus: panels.setChangesStatus,
    bubble,
    provisional,
    clearProvisional: (turnId) => { if (prov?.turnId === turnId) clearProv(); },
    open,
    setOrb,
    setConversation: panels.setConversation, setHeld: panels.setHeld, setDetails: panels.setDetails,
    setSession: panels.setSession, setFullAnswers: panels.setFullAnswers,
    isOrb(node) {
      if (orb.btn.contains(node)) return true;
      if (panels.current?.threadId === null && panels.current.root.contains(node)) return true;
      const b = bubbleOf(null);
      return !!b && b.div.contains(node);
    },
    anchorFor(node) {
      const elOf = (threadId: string | null) => (threadId ? markers.get(threadId)?.el ?? null : null);
      for (const m of markers.values()) if (m.btn.contains(node)) return m.el;
      for (const b of bubbles.values()) if (b.div.contains(node)) return elOf(b.say.threadId);
      if (panels.current && panels.current.threadId !== null && panels.current.root.contains(node)) return elOf(panels.current.threadId);
      return null;
    },
    queuedOn: (domPath) => queuedMessages(domPath).map((m) => m.text),
  };
}
