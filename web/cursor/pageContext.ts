// Captures what the user does on a page during a turn (ClientMsg turn.context → PageEvents):
// - clicks, grouped into single / double / triple / multi (4+) events with every click's timestamp;
// - the text already highlighted when the recording started;
// - each highlight made during the recording, as its own entry (a browser shows only one selection at a
//   time, so earlier highlights are painted with the CSS Custom Highlight API until the next turn).
// Pure helpers are exported for tests; the DOM wiring in createPageContextRecorder stays thin.
import type { ClickCoords, ClickKind, PageClick, PageEvents, PageHighlight, PageSelection } from "../../shared/protocol.ts";
import { clickCoords } from "../../shared/clickCoords.ts";
import { describeElement, type ElLike, type ElementInfo } from "./dom.ts";
import { HIGHLIGHT_COLOR, PRESELECTED_COLOR } from "./colors.ts";
import { withAlpha } from "../../shared/theme.ts";

/** A pointer that moved more than this between down and up was a drag (e.g. selecting text), not a click. */
export const DRAG_PX = 6;
/** Consecutive clicks on the same element at most this far apart (ms) form one double/triple/multi click. */
export const CLICK_GROUP_MS = 500;
/** …and at most this far from the group's first click (px). */
export const CLICK_GROUP_PX = 10;
/** A new highlight overlapping the previous one within this time replaces it (double → triple click on text). */
export const HIGHLIGHT_MERGE_MS = 700;
/** Selected text kept per highlight (formatPageContext truncates further for the LLM). */
export const SELECTION_KEEP = 2000;

export function isDrag(down: { x: number; y: number }, up: { x: number; y: number }, px = DRAG_PX): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) > px;
}

export function clickKind(count: number): ClickKind {
  return count <= 1 ? "single" : count === 2 ? "double" : count === 3 ? "triple" : "multi";
}

/** One press+release that wasn't a drag. */
export interface RawClick extends ElementInfo { t: number; tUp: number; x: number; y: number; coords?: ClickCoords }

/**
 * Add a click to the event list: it joins the last event when it's on the same element, within
 * CLICK_GROUP_MS of that event's last click and CLICK_GROUP_PX of its first; otherwise it starts a new
 * single click. Mutates and returns `list`.
 */
export function addClick(list: PageClick[], c: RawClick, groupMs = CLICK_GROUP_MS, groupPx = CLICK_GROUP_PX): PageClick[] {
  const last = list[list.length - 1];
  if (
    last && last.elementPath === c.elementPath &&
    c.t - last.times[last.times.length - 1]! <= groupMs &&
    Math.hypot(c.x - last.x, c.y - last.y) <= groupPx
  ) {
    last.times.push(c.t);
    if (c.coords) last.coords = [...(last.coords ?? []), c.coords];
    last.count = last.times.length;
    last.kind = clickKind(last.count);
    last.tEnd = c.tUp;
    return list;
  }
  const { t, tUp, x, y, coords, ...info } = c;
  list.push({ ...info, kind: "single", count: 1, t, tEnd: tUp, times: [t], x, y, ...(coords ? { coords: [coords] } : {}) });
  return list;
}

/** Trimmed, whitespace-normalized selection text capped at SELECTION_KEEP chars; null when empty. */
export function cleanSelection(text: string | null | undefined, max = SELECTION_KEEP): string | null {
  const t = (text ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  return t ? t.slice(0, max) : null;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Offsets of a range in document order, for overlap checks without a DOM in tests. */
export interface Span { start: number; end: number }
export const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

/**
 * Add a finished highlight: replaces the previous one when they overlap and it's within HIGHLIGHT_MERGE_MS
 * (one gesture refining its selection, e.g. the word of a double click → the paragraph of a triple click),
 * is ignored when it repeats the previous one exactly, else appended. Returns what happened.
 */
export function addHighlight(
  list: { h: PageHighlight; span: Span }[], h: PageHighlight, span: Span, mergeMs = HIGHLIGHT_MERGE_MS,
): "added" | "replaced" | "ignored" {
  const last = list[list.length - 1];
  if (last && last.span.start === span.start && last.span.end === span.end) {
    // Same range again, e.g. the word of a double click seen by both clicks: keep the more specific "via".
    if (h.via && h.via !== "drag" && last.h.via !== h.via) { last.h = { ...last.h, via: h.via }; return "replaced"; }
    return "ignored";
  }
  if (last && overlaps(last.span, span) && h.tStart - last.h.t <= mergeMs) {
    list[list.length - 1] = { h: { ...h, tStart: Math.min(h.tStart, last.h.tStart) }, span };
    return "replaced";
  }
  list.push({ h, span });
  return "added";
}

interface NodeLike { nodeType: number; parentElement: ElLike | null }

/** The element for a DOM node: itself if it's an element, else its parent element (text nodes). */
export function elementOf(node: NodeLike | null | undefined): ElLike | null {
  if (!node) return null;
  return node.nodeType === 1 ? (node as unknown as ElLike) : node.parentElement;
}

export interface PageContextRecorder {
  /** Begin a turn at client time `tFrom`: clears the previous turn and snapshots the text already highlighted. */
  start(tFrom: number): void;
  /** End the turn and return its events (an unfinished click group is included as it stands). */
  stop(): PageEvents;
  /** The current turn's events so far (live views). */
  current(): PageEvents;
  /**
   * Stop recording and forget the turn: unpaint its highlights and drop the page's text selection (so it
   * isn't picked up as "already highlighted" by the next turn). For views that don't review past turns.
   */
  clear(): void;
  /** Called after every change while recording. */
  onChange: ((ev: PageEvents) => void) | null;
  dispose(): void;
}

export interface RecorderOpts {
  /** Paint the turn's highlights (and the pre-existing one) with the CSS Custom Highlight API. Default true. */
  paint?: boolean;
}

const HL_NOW = "turn-highlights";
const HL_PRE = "turn-preselected";
const HL_STYLE = `
::highlight(${HL_NOW}) { background-color: ${withAlpha(HIGHLIGHT_COLOR, 0.38)}; color: inherit; }
::highlight(${HL_PRE}) { background-color: ${withAlpha(PRESELECTED_COLOR, 0.32)}; color: inherit; }`;

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = (): HighlightRegistry | null =>
  ((globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights) ?? null;
const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

/** Records clicks and highlights inside `root`. Clock: performance.now(). */
export function createPageContextRecorder(root: HTMLElement, opts: RecorderOpts = {}): PageContextRecorder {
  const paint = (opts.paint ?? true) && !!registry() && !!HighlightCtor;
  let active = false;
  let tFrom = 0;
  let clicks: PageClick[] = [];
  let preselected: { sel: PageSelection; range: Range } | null = null;
  let highlights: { h: PageHighlight; span: Span; range: Range }[] = [];
  let down: { t: number; x: number; y: number; target: Element; coords: ClickCoords } | null = null;
  let keySelectStart: number | null = null;

  if (paint && !document.getElementById("page-context-highlights")) {
    const style = document.createElement("style");
    style.id = "page-context-highlights";
    style.textContent = HL_STYLE;
    document.head.append(style);
  }

  const inside = (n: Node | null) => !!n && root.contains(n);
  /** Where a click at viewport point `client` landed in `el` (its container) and on the page. */
  const coordsOf = (client: { x: number; y: number }, el: Element): ClickCoords => clickCoords(
    client, { x: window.scrollX, y: window.scrollY },
    { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }, el.getBoundingClientRect(),
  );
  const describe = (el: Element | ElLike | null) => describeElement(el as unknown as ElLike, root as unknown as ElLike);
  const events = (): PageEvents => ({
    clicks: clicks.map((c) => ({ ...c, times: [...c.times] })),
    preselected: preselected?.sel ?? null,
    highlights: highlights.map((x) => x.h),
  });
  const changed = () => {
    if (paint) repaint();
    recorder.onChange?.(events());
  };

  /** Document-order offsets of a range within root (for overlap checks). */
  const spanOf = (r: Range): Span => {
    const pre = document.createRange();
    pre.selectNodeContents(root);
    pre.setEnd(r.startContainer, r.startOffset);
    const start = pre.toString().length;
    return { start, end: start + r.toString().length };
  };

  /** The current selection inside root, if any. */
  const readSelection = (): { text: string; range: Range; info: ElementInfo } | null => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    if (!inside(sel.anchorNode) || !inside(sel.focusNode)) return null;
    const text = cleanSelection(sel.toString());
    if (!text) return null;
    const range = sel.getRangeAt(0).cloneRange();
    return { text, range, info: describe(selectionElement(range, text)) };
  };

  /**
   * The smallest element containing the selected text: from the range start, walk up until the element's
   * text includes it (a triple-clicked paragraph's range spills into the next element, so the common
   * ancestor would be the whole card grid).
   */
  function selectionElement(range: Range, text: string): Element | null {
    const want = squash(text);
    let el = elementOf(range.startContainer as unknown as NodeLike) as unknown as Element | null;
    while (el && el !== root) {
      if (squash(el.textContent ?? "").includes(want)) return el;
      el = el.parentElement;
    }
    return elementOf(range.commonAncestorContainer as unknown as NodeLike) as unknown as Element | null;
  }

  function repaint(): void {
    const reg = registry()!;
    reg.delete(HL_NOW);
    reg.delete(HL_PRE);
    if (highlights.length) reg.set(HL_NOW, new HighlightCtor!(...highlights.map((x) => x.range)));
    if (preselected) reg.set(HL_PRE, new HighlightCtor!(preselected.range));
  }

  const commitHighlight = (tStart: number, t: number, via: NonNullable<PageHighlight["via"]>) => {
    if (!active) return;
    const s = readSelection();
    if (!s) return;
    const span = spanOf(s.range);
    // Still the selection that existed before the recording: not a new highlight.
    if (preselected && highlights.length === 0) {
      const p = spanOf(preselected.range);
      if (p.start === span.start && p.end === span.end) return;
    }
    const list = highlights.map(({ h, span: sp }) => ({ h, span: sp }));
    const r = addHighlight(list, { text: s.text, tStart: Math.max(tStart, tFrom), t, via, ...s.info }, span);
    if (r === "ignored") return;
    if (r === "replaced") highlights[highlights.length - 1] = { ...list[list.length - 1]!, range: s.range };
    else highlights.push({ ...list[list.length - 1]!, range: s.range });
    changed();
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    down = { t: performance.now(), x: e.clientX, y: e.clientY, target: e.target, coords: coordsOf({ x: e.clientX, y: e.clientY }, e.target) };
  };
  const onUp = (e: PointerEvent) => {
    const d = down;
    down = null;
    if (!d || !active) return;
    const tUp = performance.now();
    const drag = isDrag(d, { x: e.clientX, y: e.clientY });
    let count = 0;
    if (!drag && d.t >= tFrom && inside(d.target)) {
      const info = describe(d.target);
      if (info.elementPath) { addClick(clicks, { t: d.t, tUp, x: d.x, y: d.y, coords: d.coords, ...info }); count = clicks[clicks.length - 1]!.count; changed(); }
    }
    // The selection is final once the button is up (drag, or the word/paragraph of a double/triple click).
    const via = drag ? "drag" : count >= 4 ? "multi-click" : count === 3 ? "triple-click" : count === 2 ? "double-click" : e.shiftKey ? "shift-click" : null;
    // A plain single click doesn't make a highlight (with fast clicks it could otherwise see the next click's selection).
    if (!via) return;
    const tStart = d.t;
    setTimeout(() => commitHighlight(tStart, tUp, via), 0);
  };
  // Keyboard activation (Enter/Space on a button or link) fires click with detail 0 and no pointer events.
  const onClick = (e: MouseEvent) => {
    if (!active || e.detail !== 0 || !(e.target instanceof Element) || !inside(e.target)) return;
    const r = e.target.getBoundingClientRect();
    const t = performance.now();
    const info = describe(e.target);
    const at = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    if (info.elementPath) { clicks.push({ ...info, kind: "single", count: 1, t, tEnd: t, times: [t], x: at.x, y: at.y, coords: [coordsOf(at, e.target)] }); changed(); }
  };
  // Shift+arrow (or similar) keyboard selection: a highlight finishes when Shift is released.
  const onKeyDown = (e: KeyboardEvent) => {
    if (active && e.shiftKey && keySelectStart === null) keySelectStart = performance.now();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key !== "Shift" || keySelectStart === null) return;
    const t0 = keySelectStart;
    keySelectStart = null;
    commitHighlight(t0, performance.now(), "keyboard");
  };

  root.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointerup", onUp, true); // a drag may end outside root
  root.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);

  const recorder: PageContextRecorder = {
    onChange: null,
    start(t) {
      active = true;
      tFrom = t;
      clicks = [];
      highlights = [];
      down = null;
      keySelectStart = null;
      const s = readSelection();
      preselected = s ? { sel: { t, text: s.text, ...s.info }, range: s.range } : null;
      changed();
    },
    stop() {
      active = false;
      return events(); // highlights stay painted until the next turn starts
    },
    current: events,
    clear() {
      active = false;
      clicks = [];
      highlights = [];
      preselected = null;
      down = null;
      keySelectStart = null;
      const sel = document.getSelection();
      if (sel && (inside(sel.anchorNode) || inside(sel.focusNode))) sel.removeAllRanges();
      if (paint) repaint();
    },
    dispose() {
      active = false;
      root.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      root.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      if (paint) { registry()!.delete(HL_NOW); registry()!.delete(HL_PRE); }
    },
  };
  return recorder;
}
