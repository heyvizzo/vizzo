// Highlights each algorithm's pick (and the labeled target) on top of the demo page.
import type { PointingTarget } from "../../shared/protocol.ts";
import { ALGORITHMS } from "../../shared/pointing.ts";
import { colorFor, LABEL_COLOR } from "./colors.ts";
import type { LabelTarget, PointingLabel } from "./session.ts";

function find(path: string | null): Element | null {
  if (!path) return null;
  try {
    return document.querySelector(path);
  } catch {
    return null;
  }
}

/**
 * `layer` is an absolutely positioned, pointer-events:none child of `scroller` (position:relative),
 * so content coordinates = viewport rect − scroller rect + scroll offset.
 */
export function renderOverlay(
  layer: HTMLElement, scroller: HTMLElement, targets: PointingTarget[], labels: PointingLabel[], visible: Set<string>,
): void {
  layer.replaceChildren();
  const sr = scroller.getBoundingClientRect();
  const ox = -sr.left - scroller.clientLeft + scroller.scrollLeft;
  const oy = -sr.top - scroller.clientTop + scroller.scrollTop;

  const box = (el: Element, color: string, inset: number, text: string, dashed = false) => {
    const r = el.getBoundingClientRect();
    const d = document.createElement("div");
    d.className = "ov-box";
    Object.assign(d.style, {
      left: `${r.left + ox - inset}px`, top: `${r.top + oy - inset}px`,
      width: `${r.width + 2 * inset}px`, height: `${r.height + 2 * inset}px`,
      borderColor: color, borderStyle: dashed ? "dashed" : "solid",
    });
    const tag = document.createElement("span");
    tag.className = "ov-tag";
    tag.style.background = color;
    tag.style.color = dashed ? "#000" : "#fff";
    tag.textContent = text;
    d.append(tag);
    layer.append(d);
  };

  // Labeled targets first (underneath), dashed white.
  for (const l of labels) {
    const el = l.target && findLabel(l.target);
    if (el) box(el, LABEL_COLOR, 2 + ALGORITHMS.length * 3, `✓ "${l.word}"`, true);
  }

  // One box per (word, algorithm); several algorithms on the same element nest with growing inset.
  const perEl = new Map<Element, number>();
  for (const t of targets) {
    if (!visible.has(t.algorithm) || !t.sample) continue;
    const s = t.sample;
    const color = colorFor(t.algorithm);
    const hit = find(s.elementPath);
    const el = hit?.closest("[data-source]") ?? hit; // highlight the target element, not the inner node
    if (el) {
      const n = perEl.get(el) ?? 0;
      perEl.set(el, n + 1);
      box(el, color, n * 3, `"${t.word}" · ${t.algorithm}`);
      const tag = layer.lastElementChild!.querySelector<HTMLElement>(".ov-tag")!;
      tag.style.top = `${-16 * (n + 1) + n * 3}px`;
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
}

function findLabel(t: LabelTarget): Element | null {
  if (t.dataSource) {
    const el = document.querySelector(`[data-source="${CSS.escape(t.dataSource)}"]`);
    if (el) return el;
  }
  return find(t.elementPath);
}
