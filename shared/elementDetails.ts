// The design details of the elements a turn points at (pointing words [n] and cursor rests [@n]), formatted for the
// models like a design-feedback annotation. The solver gets everything; the router, which only has to understand the
// request, gets one compact line per element.
import type { CursorRest, CursorSample, ElementDetails, PointingTarget } from "./protocol.ts";

/** Which algorithm's pick describes a pointing word (server/adapters/claude.ts formatPointingForPrompt uses the same order). */
const ALGO_PREFERENCE = ["dwellMode", "dwell", "mode", "atStart"];

/** Most elements described per turn. */
export const MAX_DETAILED = 4;

/** The latest details per element path among the turn's samples. */
export function detailsByPath(samples: readonly CursorSample[]): Map<string, ElementDetails> {
  const out = new Map<string, ElementDetails>();
  for (const s of samples) if (s.elementPath && s.details) out.set(s.elementPath, s.details);
  return out;
}

export interface DetailedElement { refs: string[]; details: ElementDetails }

/**
 * The turn's referenced elements with details, in reference order: pointing words first ([1], [2]…), then rests
 * ([@1]…). An element referenced more than once is listed once with all its refs.
 */
export function referencedElements(
  targets: readonly PointingTarget[], rests: readonly CursorRest[], samples: readonly CursorSample[], max = MAX_DETAILED,
): DetailedElement[] {
  const byPath = detailsByPath(samples);
  const found = new Map<string, DetailedElement>();
  const add = (ref: string, sample: CursorSample | null | undefined) => {
    const path = sample?.elementPath;
    const details = path ? sample!.details ?? byPath.get(path) : undefined;
    if (!path || !details) return;
    const e = found.get(path);
    if (e) { if (!e.refs.includes(ref)) e.refs.push(ref); } else found.set(path, { refs: [ref], details });
  };
  // One target per pointing word, from the preferred algorithm that resolved it (as in the Pointing lines).
  const rank = (t: PointingTarget) => { const i = ALGO_PREFERENCE.indexOf(t.algorithm); return i < 0 ? ALGO_PREFERENCE.length : i; };
  const seen = new Set<number>();
  for (const t of [...targets].sort((a, b) => (a.ref ?? 0) - (b.ref ?? 0) || rank(a) - rank(b))) {
    if (t.ref === undefined || !t.sample || seen.has(t.ref)) continue;
    seen.add(t.ref);
    add(`[${t.ref}]`, t.sample);
  }
  for (const r of rests) add(`[@${r.ref}]`, r.sample);
  return [...found.values()].slice(0, max);
}

const STYLE_SKIP = new Set(["0px", "none", "normal", "auto", "static", "1", "rgba(0, 0, 0, 0)"]);

/** The computed styles as `prop: value` pairs, skipping values that are just defaults (0px margins, no border…). */
function styleLines(styles: Record<string, string>): string[] {
  return Object.entries(styles)
    .filter(([p, v]) => !STYLE_SKIP.has(v) && !(p === "border" && /^0px\b/.test(v)))
    .map(([p, v]) => `${p}: ${v}`);
}

const attrText = (attrs: Record<string, string>) => Object.entries(attrs).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");

/** `[1] [@1] <span> "Your role: Owner" — \`div.header-meta > span.muted\`, data-testid="own-role", 202×23 at (977, 171)`. */
export function formatElementCompact(e: DetailedElement): string {
  const d = e.details;
  const parts = [`\`${d.selector}\``];
  if (d.react) parts.push(`in <${d.react.chain[0]}>`);
  const attrs = attrText(d.attrs);
  if (attrs) parts.push(attrs);
  parts.push(`${d.bounds.width}×${d.bounds.height} at (${d.bounds.x}, ${d.bounds.y})`);
  return `${e.refs.join(" ")} <${d.tag}>${d.text ? ` ${JSON.stringify(d.text.length > 80 ? `${d.text.slice(0, 79)}…` : d.text)}` : ""} — ${parts.join(", ")}`;
}

/** Everything about one element, a field per line (selector, DOM path, classes, bounds, text, styles, HTML). */
export function formatElementFull(e: DetailedElement): string {
  const d = e.details;
  const lines = [
    `${e.refs.join(" ")} <${d.tag}>${d.text ? ` ${JSON.stringify(d.text.length > 80 ? `${d.text.slice(0, 79)}…` : d.text)}` : ""}`,
    `   Selector: \`${d.selector}\``,
    `   DOM path: \`${d.domPath}\``,
  ];
  if (d.classes.length) lines.push(`   Classes: \`${d.classes.join(" ")}\``);
  const attrs = attrText(d.attrs);
  if (attrs) lines.push(`   Attributes: ${attrs}`);
  lines.push(`   Bounds: x=${d.bounds.x}, y=${d.bounds.y}, ${d.bounds.width}×${d.bounds.height}`);
  if (d.text && d.text.length > 80) lines.push(`   Text: ${JSON.stringify(d.text)}`);
  if (d.react) {
    const [nearest, ...above] = d.react.chain;
    lines.push(`   React component: <${nearest}>${above.length ? ` in ${above.join(" > ")}` : ""}`);
    if (d.react.production) lines.push("   (React production build: only components with an explicit displayName are named; there's no source location.)");
    if (d.react.props) lines.push(`   Props of <${nearest}>: ${d.react.props}`);
    if (d.react.source) lines.push(`   JSX written at: ${d.react.source}${d.react.sourceExact ? "" : " (line as served by the dev server: may be off by a few)"}`);
  }
  const styles = styleLines(d.styles);
  if (styles.length) lines.push(`   Computed styles: ${styles.join("; ")}`);
  lines.push(`   HTML: ${d.html.replace(/\s*\n\s*/g, " ")}`);
  return lines.join("\n");
}

/** The block for a prompt ("" when no referenced element has details). */
export function formatElementDetails(elements: readonly DetailedElement[], full: boolean): string {
  if (!elements.length) return "";
  const vp = elements[0]!.details.viewport;
  const head = `Elements referenced above (viewport ${vp.width}×${vp.height}, bounds in viewport px):`;
  return [head, ...elements.map(full ? formatElementFull : formatElementCompact)].join("\n");
}
