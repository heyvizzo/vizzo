// Design details of a pointed-at element, like a design-feedback annotation: a short selector, the full DOM path,
// classes, bounds, a fixed set of computed styles and the markup. Only taken when the pointer reaches a new element
// (computed styles are too costly for every 60 Hz sample). The path helpers run on a minimal element interface so
// they're unit-testable without a DOM.
import type { ElementDetails } from "../../shared/protocol.ts";
import type { ElLike } from "./dom.ts";

/** Computed style properties recorded, in this order. */
export const STYLE_PROPS = [
  "display", "position", "width", "height", "margin", "padding", "color", "background-color", "border", "border-radius",
  "font-family", "font-size", "font-weight", "line-height", "text-align", "gap", "opacity",
] as const;
/** Attributes worth showing (besides class). */
const ATTRS = ["id", "data-testid", "data-test", "data-cy", "data-source", "data-label", "role", "name", "type", "href", "src", "alt", "title", "placeholder", "aria-label"];
export const HTML_MAX = 600;
export const TEXT_MAX = 200;
/** Classes per path segment (utility-class soup stays readable). */
const SEG_CLASSES = 3;

const SAFE_IDENT = /^-?[A-Za-z_][\w-]*$/;

export function classesOf(el: ElLike): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** `tag#id` or `tag.cls1.cls2` (CSS-safe ids/classes only, at most SEG_CLASSES classes). */
export function describeSegment(el: ElLike): string {
  const tag = el.tagName.toLowerCase();
  if (el.id && SAFE_IDENT.test(el.id)) return `${tag}#${el.id}`;
  const cls = classesOf(el).filter((c) => SAFE_IDENT.test(c)).slice(0, SEG_CLASSES);
  return tag + cls.map((c) => `.${c}`).join("");
}

/** `div.header-meta > span.muted`: the parent's segment and the element's (just the element's when it has an id). */
export function shortSelector(el: ElLike): string {
  const own = describeSegment(el);
  const parent = el.parentElement;
  if (own.includes("#") || !parent || parent.tagName.toLowerCase() === "html") return own;
  return `${describeSegment(parent)} > ${own}`;
}

/**
 * `body > div#app > main#main-content > div.card:nth-of-type(2) > span.muted`: every segment from body down, with the
 * position among siblings of the same tag where there are several, so sibling elements (cards, list items, buttons
 * in a row) each get their own path: it keys an element's thread and its queued feedback (shared/anchor.ts).
 */
export function domPath(el: ElLike): string {
  const parts: string[] = [];
  for (let cur: ElLike | null = el; cur && cur.tagName.toLowerCase() !== "html"; cur = cur.parentElement) {
    const seg = describeSegment(cur);
    const parent = cur.parentElement;
    const same = !seg.includes("#") && parent ? Array.from(parent.children).filter((c) => c.tagName === cur!.tagName) : [];
    parts.unshift(same.length > 1 ? `${seg}:nth-of-type(${same.indexOf(cur) + 1})` : seg);
  }
  return parts.join(" > ");
}

export function pickAttrs(el: ElLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v !== null && v !== "") out[a] = v.length > 120 ? `${v.slice(0, 119)}…` : v;
  }
  return out;
}

export function capText(s: string | null | undefined, max: number): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t) : null;
}

/** The details of a live element (needs a DOM). */
export function elementDetails(el: Element): ElementDetails {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const styles: Record<string, string> = {};
  for (const p of STYLE_PROPS) {
    const v = cs.getPropertyValue(p);
    if (v) styles[p] = v;
  }
  const html = el.outerHTML;
  const like = el as unknown as ElLike;
  return {
    selector: shortSelector(like),
    domPath: domPath(like),
    tag: el.tagName.toLowerCase(),
    classes: classesOf(like),
    attrs: pickAttrs(like),
    text: capText((el as HTMLElement).innerText ?? el.textContent, TEXT_MAX),
    bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    viewport: { width: innerWidth, height: innerHeight },
    styles,
    html: html.length > HTML_MAX ? `${html.slice(0, HTML_MAX - 1)}…` : html,
  };
}
