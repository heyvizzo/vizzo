// Captures what the user clicks and highlights on a page during a turn (ClientMsg turn.context).
// Pure helpers are exported for tests; the DOM wiring in createPageContextRecorder stays thin.
import type { PageClick, PageSelection } from "../../shared/protocol.ts";
import { describeElement, type ElLike } from "./dom.ts";

/** A pointer that moved more than this between down and up was a drag (e.g. selecting text), not a click. */
export const DRAG_PX = 6;
/** A keyboard `click` right after a recorded pointer click on the same element is the same click. */
export const SAME_CLICK_MS = 800;
/** Selected text kept per turn (formatPageContext truncates further for the LLM). */
export const SELECTION_KEEP = 2000;

export function isDrag(down: { x: number; y: number }, up: { x: number; y: number }, px = DRAG_PX): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) > px;
}

/** Append `c` unless it repeats the previous click (same element within SAME_CLICK_MS). Returns the list. */
export function pushClick(list: PageClick[], c: PageClick, sameMs = SAME_CLICK_MS): PageClick[] {
  const prev = list[list.length - 1];
  if (prev && prev.elementPath === c.elementPath && Math.abs(c.t - prev.t) <= sameMs) return list;
  list.push(c);
  return list;
}

/** Trimmed, whitespace-normalized selection text capped at SELECTION_KEEP chars; null when empty. */
export function cleanSelection(text: string | null | undefined, max = SELECTION_KEEP): string | null {
  const t = (text ?? "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  return t ? t.slice(0, max) : null;
}

interface NodeLike { nodeType: number; parentElement: ElLike | null }

/** The element for a DOM node: itself if it's an element, else its parent element (text nodes). */
export function elementOf(node: NodeLike | null | undefined): ElLike | null {
  if (!node) return null;
  return node.nodeType === 1 ? (node as unknown as ElLike) : node.parentElement;
}

export interface PageContextRecorder {
  /** Begin recording clicks (t ≥ tFrom) and selections for a turn; clears the previous turn. */
  start(tFrom: number): void;
  /** Stop and return the turn's clicks and the latest selection (including one still active from before the turn). */
  stop(): { clicks: PageClick[]; selection: PageSelection | null };
  dispose(): void;
}

/** Records clicks inside `root` (capture phase) and the latest selection inside `root`. Clock: performance.now(). */
export function createPageContextRecorder(root: HTMLElement): PageContextRecorder {
  let active = false;
  let tFrom = 0;
  let clicks: PageClick[] = [];
  let selection: PageSelection | null = null;
  let down: { t: number; x: number; y: number; target: Element } | null = null;

  const inside = (n: Node | null) => !!n && root.contains(n);

  const record = (target: Element, t: number, x: number, y: number) => {
    if (!active || t < tFrom || !inside(target)) return;
    const info = describeElement(target as unknown as ElLike, root as unknown as ElLike);
    if (!info.elementPath) return;
    pushClick(clicks, { t, x, y, ...info });
  };

  const readSelection = (t: number): PageSelection | null => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    if (!inside(sel.anchorNode) || !inside(sel.focusNode)) return null;
    const text = cleanSelection(sel.toString());
    if (!text) return null;
    const el = elementOf(sel.getRangeAt(0).commonAncestorContainer as unknown as NodeLike);
    return { t, text, ...describeElement(el, root as unknown as ElLike) };
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    down = { t: performance.now(), x: e.clientX, y: e.clientY, target: e.target };
  };
  const onUp = (e: PointerEvent) => {
    const d = down;
    down = null;
    if (!d || isDrag(d, { x: e.clientX, y: e.clientY })) return; // a drag (text selection) isn't a click
    record(d.target, d.t, d.x, d.y);
  };
  // Keyboard activation (Enter/Space on a button or link) fires click with detail 0 and no pointer events.
  const onClick = (e: MouseEvent) => {
    if (e.detail === 0 && e.target instanceof Element) {
      const r = e.target.getBoundingClientRect();
      record(e.target, performance.now(), r.left + r.width / 2, r.top + r.height / 2);
    }
  };
  const onSelection = () => {
    if (!active) return;
    const s = readSelection(performance.now());
    if (s) selection = s;
  };

  root.addEventListener("pointerdown", onDown, true);
  root.addEventListener("pointerup", onUp, true);
  root.addEventListener("click", onClick, true);
  document.addEventListener("selectionchange", onSelection);

  return {
    start(t) {
      active = true;
      tFrom = t;
      clicks = [];
      selection = null;
      down = null;
    },
    stop() {
      // The selection that's active now wins (it's the latest). If selectionchange didn't record it
      // during the turn, it was made before the turn and is still active: it counts, stamped tFrom.
      const current = readSelection(tFrom);
      if (current && current.text !== selection?.text) selection = current;
      active = false;
      return { clicks: [...clicks], selection };
    },
    dispose() {
      active = false;
      root.removeEventListener("pointerdown", onDown, true);
      root.removeEventListener("pointerup", onUp, true);
      root.removeEventListener("click", onClick, true);
      document.removeEventListener("selectionchange", onSelection);
    },
  };
}
