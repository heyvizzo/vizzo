// Highlights each algorithm's pick (and the labeled target) on top of the demo page, the turn's
// clicks and selection, and (separately, live) the element under the pointer.
import type { CursorSample, PageClick, PageSelection, PointingTarget } from "../../shared/protocol.ts";
import { ALGORITHMS } from "../../shared/pointing.ts";
import { CLICK_COLOR, colorFor, HOVER_COLOR, LABEL_COLOR, SELECTION_COLOR } from "./colors.ts";
import type { LabelTarget, PointingLabel } from "./session.ts";

export function findPath(path: string | null): Element | null {
  if (!path) return null;
  try {
    return document.querySelector(path);
  } catch {
    return null;
  }
}

/** Offsets that turn viewport coordinates into the scroller's content coordinates. */
function origin(scroller: HTMLElement) {
  const sr = scroller.getBoundingClientRect();
  return { sr, ox: -sr.left - scroller.clientLeft + scroller.scrollLeft, oy: -sr.top - scroller.clientTop + scroller.scrollTop };
}

function place(d: HTMLElement, r: DOMRect, ox: number, oy: number, inset: number): void {
  Object.assign(d.style, {
    left: `${r.left + ox - inset}px`, top: `${r.top + oy - inset}px`,
    width: `${r.width + 2 * inset}px`, height: `${r.height + 2 * inset}px`,
  });
}

export interface PageMarks {
  clicks: readonly PageClick[];
  selection: PageSelection | null;
  /** The session's samples (same clock as clicks): their scroll offsets place click dots in content coords. */
  samples: readonly CursorSample[];
}

/**
 * `layer` is an absolutely positioned, pointer-events:none child of `scroller` (position:relative),
 * so content coordinates = viewport rect − scroller rect + scroll offset.
 */
export function renderOverlay(
  layer: HTMLElement, scroller: HTMLElement, targets: PointingTarget[], labels: PointingLabel[], visible: Set<string>,
  page: PageMarks | null = null,
): void {
  layer.replaceChildren();
  const { sr, ox, oy } = origin(scroller);

  const box = (el: Element, color: string, inset: number, text: string, style: "solid" | "dashed" | "dotted" = "solid") => {
    const d = document.createElement("div");
    d.className = "ov-box";
    place(d, el.getBoundingClientRect(), ox, oy, inset);
    Object.assign(d.style, { borderColor: color, borderStyle: style });
    const tag = document.createElement("span");
    tag.className = "ov-tag";
    tag.style.background = color;
    tag.style.color = style === "solid" && color !== CLICK_COLOR ? "#fff" : "#000";
    tag.textContent = text;
    d.append(tag);
    layer.append(d);
    return d;
  };

  // Labeled targets first (underneath), dashed white.
  for (const l of labels) {
    const el = l.target && findLabel(l.target);
    if (el) box(el, LABEL_COLOR, 2 + ALGORITHMS.length * 3, `✓ "${l.word}"`, "dashed");
  }

  // One box per (word, algorithm) around the specific element; several algorithms on one element nest.
  const perEl = new Map<Element, number>();
  for (const t of targets) {
    if (!visible.has(t.algorithm) || !t.sample) continue;
    const s = t.sample;
    const color = colorFor(t.algorithm);
    const el = findPath(s.elementPath);
    if (el) {
      const n = perEl.get(el) ?? 0;
      perEl.set(el, n + 1);
      const d = box(el, color, n * 3, `"${t.word}" · ${t.algorithm}`);
      d.querySelector<HTMLElement>(".ov-tag")!.style.top = `${-16 * (n + 1) + n * 3}px`;
    }
    // The sampled pointer position (content coords at sample time).
    const dot = document.createElement("div");
    dot.className = "ov-dot";
    Object.assign(dot.style, {
      left: `${s.x - sr.left - scroller.clientLeft + s.scrollX}px`,
      top: `${s.y - sr.top - scroller.clientTop + s.scrollY}px`,
      background: color,
    });
    dot.title = `${t.algorithm} "${t.word}"`;
    layer.append(dot);
  }

  if (!page) return;
  if (page.selection) {
    const el = findPath(page.selection.elementPath);
    if (el) box(el, SELECTION_COLOR, 6, "selected text", "dotted").querySelector<HTMLElement>(".ov-tag")!.style.top = "calc(100% + 2px)";
  }
  [...page.clicks].sort((a, b) => a.t - b.t).forEach((c, i) => {
    const el = findPath(c.elementPath);
    if (el) box(el, CLICK_COLOR, 1, `click ${i + 1}`).querySelector<HTMLElement>(".ov-tag")!.style.top = "calc(100% + 2px)"; // below, so pick tags above stay readable
    // Clicks carry viewport x/y only; take the scroll offset from the nearest cursor sample.
    const near = nearestSample(page.samples, c.t);
    const dot = document.createElement("div");
    dot.className = "ov-click";
    dot.textContent = String(i + 1);
    Object.assign(dot.style, {
      left: `${c.x - sr.left - scroller.clientLeft + (near?.scrollX ?? scroller.scrollLeft)}px`,
      top: `${c.y - sr.top - scroller.clientTop + (near?.scrollY ?? scroller.scrollTop)}px`,
    });
    dot.title = `click ${i + 1}: ${c.label ?? c.elementPath ?? "?"}`;
    layer.append(dot);
  });
}

function nearestSample(samples: readonly CursorSample[], t: number): CursorSample | null {
  let best: CursorSample | null = null;
  for (const s of samples) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  return best;
}

function findLabel(t: LabelTarget): Element | null {
  if (t.dataSource) {
    const el = document.querySelector(`[data-source="${CSS.escape(t.dataSource)}"]`);
    if (el) return el;
  }
  return findPath(t.elementPath);
}

/**
 * Live hover outline, in its own layer: a thin solid box around the specific element under the
 * pointer and a faint dashed one around its container. Nulls hide them.
 */
export function renderHover(layer: HTMLElement, scroller: HTMLElement, el: Element | null, container: Element | null): void {
  if (!layer.childElementCount) {
    for (const cls of ["ov-hover-container", "ov-hover"]) {
      const d = document.createElement("div");
      d.className = cls;
      d.style.borderColor = HOVER_COLOR;
      layer.append(d);
    }
  }
  const cBox = layer.children[0] as HTMLElement;
  const eBox = layer.children[1] as HTMLElement;
  const { ox, oy } = origin(scroller);
  for (const [d, target, inset] of [[eBox, el, 2], [cBox, container, 5]] as const) {
    d.hidden = !target;
    if (target) place(d, target.getBoundingClientRect(), ox, oy, inset);
  }
}
