// Back/forward in the browser pane, as in a browser: the mouse's side buttons (3 = back, 4 = forward) and the
// trackpad's two-finger horizontal swipe. Electron's views do neither on their own. Runs in the page preload.
// A swipe counts only when it starts where nothing under the pointer can scroll that way (a carousel, a wide table
// or a horizontally scrolled page scroll first, as in Chrome) and the page doesn't take the wheel itself
// (preventDefault: maps, sliders, the drawing overlay). An arrow at the edge fills in as the swipe goes; past the
// threshold it navigates once. The momentum after it (macOS keeps sending wheel events for a second or so after the
// fingers lift, into the page the swipe opened too) is ignored until the deltas rise again: the fingers are back,
// swiping again, so swipes go back several pages in a row.

export type NavDir = "back" | "forward";

/** Horizontal travel (px of wheel delta) that navigates. */
export const SWIPE_THRESHOLD = 200;
/** A pause this long between wheel events ends the gesture (momentum events come every ~16 ms). */
export const GESTURE_GAP_MS = 250;
/** A page opened by a swipe this recently starts out ignoring that swipe's momentum. */
export const MOMENTUM_MS = 1500;
/** In momentum, this many rising deltas in a row are a new swipe (momentum only decays). */
const RISES = 2;

export interface WheelSample {
  dx: number;
  dy: number;
  t: number;
  /** The wheel is taken: something under the pointer can still scroll that way, or the page called preventDefault. */
  taken: boolean;
  /** History has an entry that way. */
  can: (dir: NavDir) => boolean;
}

export type SwipeUpdate =
  | { type: "none" }
  | { type: "progress"; dir: NavDir; progress: number }
  | { type: "navigate"; dir: NavDir };

type State =
  | { kind: "idle" }
  | { kind: "ignore"; last: number }
  | { kind: "momentum"; last: number; prev: number | null; rises: number }
  | { kind: "track"; dir: NavDir; sx: number; sy: number; last: number };

/** Turns wheel events into swipe progress and, past the threshold, one navigation per gesture. */
export function createSwipeTracker() {
  let state: State = { kind: "idle" };
  return {
    wheel(s: WheelSample): SwipeUpdate {
      if (state.kind !== "idle" && s.t - state.last > GESTURE_GAP_MS) state = { kind: "idle" };
      if (state.kind === "ignore") { state.last = s.t; return { type: "none" }; }
      if (state.kind === "momentum") {
        const size = Math.max(Math.abs(s.dx), Math.abs(s.dy));
        state.rises = state.prev !== null && size >= 3 && size > state.prev * 1.3 + 1 ? state.rises + 1 : 0;
        state.prev = size;
        state.last = s.t;
        if (state.rises < RISES) return { type: "none" };
        state = { kind: "idle" };
      }
      if (state.kind === "idle") {
        if (!s.dx && !s.dy) return { type: "none" };
        // Fingers moving right scroll content left (dx < 0): back, as in Safari and Chrome.
        const dir: NavDir = s.dx < 0 ? "back" : "forward";
        if (Math.abs(s.dx) <= Math.abs(s.dy) || s.taken || !s.can(dir)) {
          state = { kind: "ignore", last: s.t };
          return { type: "none" };
        }
        state = { kind: "track", dir, sx: 0, sy: 0, last: s.t };
      }
      state.sx += s.dx;
      state.sy += s.dy;
      state.last = s.t;
      const travel = state.dir === "back" ? -state.sx : state.sx;
      if (Math.abs(state.sy) > Math.abs(state.sx)) {
        const dir = state.dir;
        state = { kind: "ignore", last: s.t };
        return { type: "progress", dir, progress: 0 };
      }
      if (travel >= SWIPE_THRESHOLD) {
        const dir = state.dir;
        state = { kind: "momentum", last: s.t, prev: null, rises: 0 };
        return { type: "navigate", dir };
      }
      return { type: "progress", dir: state.dir, progress: Math.max(0, travel) / SWIPE_THRESHOLD };
    },
    /** The page was opened by a swipe: what's left of it is momentum. */
    momentum(t: number) {
      state = { kind: "momentum", last: t, prev: null, rises: 0 };
    },
  };
}

/** Side buttons: 3 is back, 4 is forward (MouseEvent.button). */
export function buttonDir(button: number): NavDir | null {
  return button === 3 ? "back" : button === 4 ? "forward" : null;
}

const SCROLLS = /^(auto|scroll|overlay)$/;

/** Whether `el` or an ancestor (crossing shadow roots) can still scroll horizontally in the direction of dx. */
function canScrollX(path: EventTarget[], dx: number): boolean {
  const scrolling = document.scrollingElement;
  for (const node of path) {
    if (!(node instanceof Element)) continue;
    const max = node.scrollWidth - node.clientWidth;
    if (max < 1) continue;
    const style = getComputedStyle(node);
    const scrolls = node === scrolling ? style.overflowX !== "hidden" && style.overflowX !== "clip"
      : SCROLLS.test(style.overflowX) || node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement;
    if (!scrolls) continue;
    // RTL: scrollLeft runs from 0 (right edge) to -max (left edge).
    const fromLeft = style.direction === "rtl" ? max + node.scrollLeft : node.scrollLeft;
    if (dx < 0 ? fromLeft > 0.5 : fromLeft < max - 0.5) return true;
  }
  return false;
}

const ARROW_CSS = `
.arrow { position: fixed; top: 50%; width: 44px; height: 44px; margin-top: -22px; border-radius: 50%;
  display: grid; place-items: center; background: rgba(60, 60, 67, 0.82); color: #fff; opacity: 0;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25); transition: opacity 160ms ease, background-color 120ms ease; }
.arrow.back { left: 0; } .arrow.forward { right: 0; }
.arrow.ready { background: #0a84ff; }
.arrow svg { width: 20px; height: 20px; }`;

/** The arrow at the pane's edge: slides in with the swipe's progress, blue once letting go would navigate. */
function createArrow() {
  let host: HTMLElement | null = null;
  let arrow: HTMLElement | null = null;
  let hideTimer = 0;
  const build = () => {
    host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = ARROW_CSS;
    arrow = document.createElement("div");
    arrow.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 10H4M9 5l-5 5 5 5"/></svg>`;
    shadow.append(style, arrow);
  };
  const hide = () => {
    clearTimeout(hideTimer);
    if (arrow) arrow.style.opacity = "0";
    hideTimer = window.setTimeout(() => host?.remove(), 200);
  };
  return {
    show(dir: NavDir, progress: number) {
      if (!document.documentElement) return;
      if (!host) build();
      if (!host!.isConnected) document.documentElement.append(host!);
      clearTimeout(hideTimer);
      const p = Math.min(1, progress);
      arrow!.className = `arrow ${dir}${p >= 1 ? " ready" : ""}`;
      // From just off the edge to 16px inside it.
      const x = -44 + 60 * p;
      arrow!.style.transform = `translateX(${dir === "back" ? x : -x}px) ${dir === "forward" ? "scaleX(-1)" : ""}`;
      arrow!.style.opacity = String(Math.min(1, p * 1.6));
      // Fingers lifted without enough travel (no more wheel events): fade out.
      hideTimer = window.setTimeout(hide, GESTURE_GAP_MS);
    },
    hide,
  };
}

export interface HistoryNavOptions {
  go: (dir: NavDir, via: "button" | "swipe") => void;
  can: (dir: NavDir) => boolean;
}

/**
 * Listens on the window (bubble phase, after the page's own handlers) for side buttons and swipes. Call the returned
 * `momentum` when this page was opened by a swipe a moment ago.
 */
export function installHistoryNav({ go, can }: HistoryNavOptions): { momentum: () => void } {
  // Decided after the event's dispatch, so a page that handles the button itself (preventDefault) keeps it.
  window.addEventListener("mouseup", (e) => {
    const dir = buttonDir(e.button);
    if (!dir) return;
    setTimeout(() => { if (!e.defaultPrevented && can(dir)) go(dir, "button"); }, 0);
  });

  const tracker = createSwipeTracker();
  const arrow = createArrow();
  window.addEventListener("wheel", (e) => {
    // Pinch-zoom (ctrlKey) and line/page wheels (a mouse) aren't swipes. Where it can scroll is read now, before
    // this event scrolls it; whether the page took the event, once its handlers have run.
    if (e.ctrlKey || e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return;
    const scrollable = e.deltaX !== 0 && canScrollX(e.composedPath(), e.deltaX);
    const t = e.timeStamp;
    setTimeout(() => {
      const update = tracker.wheel({ dx: e.deltaX, dy: e.deltaY, t, taken: scrollable || e.defaultPrevented, can });
      if (update.type === "progress") update.progress > 0 ? arrow.show(update.dir, update.progress) : arrow.hide();
      else if (update.type === "navigate") { arrow.show(update.dir, 1); go(update.dir, "swipe"); }
    }, 0);
  }, { passive: true });
  return { momentum: () => tracker.momentum(performance.now()) };
}
