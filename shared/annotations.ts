// Drawing feedback is captured against one immutable viewport image. Coordinates are CSS pixels in that image.
import type { CursorSample, ElementDetails } from "./protocol.ts";

export type DrawingTool = "pen" | "arrow" | "rectangle" | "ellipse";
export const DRAWING_STYLES = ["normal", "dashed", "dotted"] as const;
export type DrawingStyle = typeof DRAWING_STYLES[number];
export const DRAWING_WIDTHS = [1.5, 3, 5, 8, 12] as const;
export type DrawingWidth = typeof DRAWING_WIDTHS[number];
export const DRAWING_WIDTH: DrawingWidth = DRAWING_WIDTHS[1];
export interface DrawingPoint { x: number; y: number }
export interface DrawingStroke {
  id: string;
  /** Stable visible mark number; moving a mark never renumbers it. */
  label?: number;
  /** Original creation interval in epoch milliseconds; moving a mark never changes it. */
  startedAt?: number;
  endedAt?: number;
  tool: DrawingTool;
  points: DrawingPoint[];
  /** Hex RGB. Older drawings without a color use DRAWING_COLOR. */
  color?: string;
  /** CSS pixels in the captured viewport. Older drawings use level 2 (3 px). */
  width?: DrawingWidth;
  /** Older drawings use a normal, continuous stroke. */
  style?: DrawingStyle;
}
export interface DrawingSpeechPhrase {
  id: string;
  text: string;
  /** Epoch milliseconds. Word timing is precise; clip timing uses the recording interval. */
  startedAt: number;
  endedAt: number;
  /** IDs of retained strokes; empty when this phrase is unlinked. */
  strokeIds: string[];
  source: "automatic" | "selected" | "manual" | "unlinked";
  timing: "word" | "clip";
}
export interface DrawingVoiceNote {
  id: string;
  startedAt: number;
  endedAt: number;
  phrases: DrawingSpeechPhrase[];
}
export interface DrawingAnnotation {
  version: 1;
  id: string;
  pageUrl: string;
  createdAt: number;
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  strokes: DrawingStroke[];
  voiceNotes?: DrawingVoiceNote[];
  /** Element details collected from the captured page, before it can change. */
  targetSamples: CursorSample[];
  /** Captured element used to keep the drawing marker attached through layout changes. */
  markerSample?: CursorSample;
  /** Page image with the strokes composited, excluding Vizzo's controls. */
  image: { dataUrl: string; width: number; height: number };
}

export const DRAWING_COLOR = "#ff365e";
export const DRAWING_COLORS = [
  { name: "Red", value: DRAWING_COLOR },
  { name: "Orange", value: "#f97316" },
  { name: "Yellow", value: "#facc15" },
  { name: "Green", value: "#22c55e" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Purple", value: "#a855f7" },
  { name: "Black", value: "#18181b" },
  { name: "White", value: "#ffffff" },
] as const;
export const MAX_DRAWING_STROKES = 200;
export const MAX_DRAWING_POINTS = 20_000;
export const MAX_DRAWING_IMAGE_CHARS = 4_000_000;
export const MAX_DRAWING_TARGETS = 12;
export const MAX_DRAWING_VOICE_NOTES = 100;
/** Total phrases across all voice notes in one annotation. */
export const MAX_DRAWING_PHRASES = 500;
/** Total phrase text characters across one annotation. */
export const MAX_DRAWING_VOICE_TEXT = 64_000;

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const timestamp = (x: unknown): x is number => finite(x) && x >= 0;
const identifier = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 128;
const interval = (start: unknown, end: unknown): boolean => timestamp(start) && timestamp(end) && start <= end;
const dimension = (x: unknown): x is number => finite(x) && x > 0 && x <= 16_384;
const text = (x: unknown, max = 8192): x is string => typeof x === "string" && x.length <= max;
const nullableText = (x: unknown): boolean => x === null || text(x);
const stringList = (x: unknown): boolean => Array.isArray(x) && x.length <= 200 && x.every(v => text(v));
const stringMap = (x: unknown): boolean => !!x && typeof x === "object" && !Array.isArray(x)
  && Object.keys(x).length <= 200 && Object.entries(x).every(([k, v]) => text(k, 256) && text(v));
const validColor = (color: unknown): color is string => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color);
const validWidth = (width: unknown): width is DrawingWidth => DRAWING_WIDTHS.some(value => value === width);
const validStyle = (style: unknown): style is DrawingStyle => DRAWING_STYLES.some(value => value === style);
export const drawingStrokeColor = (stroke: DrawingStroke): string => validColor(stroke.color) ? stroke.color.toLowerCase() : DRAWING_COLOR;
export const drawingStrokeWidth = (stroke: DrawingStroke): DrawingWidth => validWidth(stroke.width) ? stroke.width : DRAWING_WIDTH;
export const drawingStrokeStyle = (stroke: DrawingStroke): DrawingStyle => validStyle(stroke.style) ? stroke.style : "normal";
/** Both the ink and its outline use the same dash spacing so their marks stay aligned. */
export function drawingDashArray(style: DrawingStyle, width: number): string | null {
  if (style === "dashed") return `${width * 3} ${Math.max(6, width * 2.5)}`;
  if (style === "dotted") return `0 ${Math.max(8, width * 2.5)}`;
  return null;
}
/** Keep pale ink visible on light screenshots, and dark ink visible on dark screenshots. */
export function drawingColorContrast(color: string): string {
  const rgb = parseInt(validColor(color) ? color.slice(1) : DRAWING_COLOR.slice(1), 16);
  return ((rgb >> 16) * .2126 + ((rgb >> 8) & 255) * .7152 + (rgb & 255) * .0722) > 178 ? "#18181b" : "#ffffff";
}

/** These fields are later formatted as model context; reject malformed nested metadata too. */
function validDetails(d: ElementDetails): boolean {
  return !!d && text(d.selector) && text(d.domPath) && text(d.tag, 256) && stringList(d.classes)
    && stringMap(d.attrs) && stringMap(d.styles) && nullableText(d.text) && text(d.html, 32_768)
    && !!d.bounds && [d.bounds.x, d.bounds.y, d.bounds.width, d.bounds.height].every(finite)
    && !!d.viewport && dimension(d.viewport.width) && dimension(d.viewport.height)
    && (d.react === undefined || (!!d.react && stringList(d.react.chain)
      && (d.react.props === undefined || text(d.react.props)) && (d.react.source === undefined || text(d.react.source))));
}

/** Validate at the IPC and websocket boundaries before retaining image data. */
export function isDrawingAnnotation(value: unknown): value is DrawingAnnotation {
  if (!value || typeof value !== "object") return false;
  const a = value as DrawingAnnotation;
  if (a.version !== 1 || typeof a.id !== "string" || !a.id || a.id.length > 128
    || typeof a.pageUrl !== "string" || a.pageUrl.length > 8192 || !timestamp(a.createdAt)) return false;
  if (!a.viewport || !dimension(a.viewport.width) || !dimension(a.viewport.height)
    || !finite(a.viewport.scrollX) || !finite(a.viewport.scrollY)) return false;
  if (!a.image || !dimension(a.image.width) || !dimension(a.image.height)
    || typeof a.image.dataUrl !== "string" || a.image.dataUrl.length > MAX_DRAWING_IMAGE_CHARS
    || !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(a.image.dataUrl)) return false;
  if (!Array.isArray(a.strokes) || !a.strokes.length || a.strokes.length > MAX_DRAWING_STROKES) return false;
  let points = 0;
  const strokeIds = new Set<string>(), labels = new Set<number>();
  for (const s of a.strokes) {
    if (!s || !identifier(s.id) || strokeIds.has(s.id) || !["pen", "arrow", "rectangle", "ellipse"].includes(s.tool)
      || !Array.isArray(s.points) || s.points.length < 2) return false;
    strokeIds.add(s.id);
    if (s.label !== undefined) {
      if (!Number.isInteger(s.label) || s.label <= 0 || s.label > 1_000_000 || labels.has(s.label)) return false;
      labels.add(s.label);
    }
    if (s.startedAt !== undefined && !timestamp(s.startedAt)) return false;
    if (s.endedAt !== undefined && !timestamp(s.endedAt)) return false;
    if (s.startedAt !== undefined && s.endedAt !== undefined && s.startedAt > s.endedAt) return false;
    if (s.color !== undefined && !validColor(s.color)) return false;
    if (s.width !== undefined && !validWidth(s.width)) return false;
    if (s.style !== undefined && !validStyle(s.style)) return false;
    points += s.points.length;
    if (points > MAX_DRAWING_POINTS) return false;
    if (s.points.some(p => !p || !finite(p.x) || !finite(p.y) || p.x < 0 || p.y < 0
      || p.x > a.viewport.width || p.y > a.viewport.height)) return false;
  }
  if (a.voiceNotes !== undefined) {
    if (!Array.isArray(a.voiceNotes) || a.voiceNotes.length > MAX_DRAWING_VOICE_NOTES) return false;
    const noteIds = new Set<string>(), phraseIds = new Set<string>();
    let phraseCount = 0, textChars = 0;
    for (const note of a.voiceNotes) {
      if (!note || !identifier(note.id) || noteIds.has(note.id) || !interval(note.startedAt, note.endedAt)
        || !Array.isArray(note.phrases)) return false;
      noteIds.add(note.id);
      phraseCount += note.phrases.length;
      if (phraseCount > MAX_DRAWING_PHRASES) return false;
      for (const phrase of note.phrases) {
        if (!phrase || !identifier(phrase.id) || phraseIds.has(phrase.id)
          || !text(phrase.text, MAX_DRAWING_VOICE_TEXT) || !interval(phrase.startedAt, phrase.endedAt)
          || !["automatic", "selected", "manual", "unlinked"].includes(phrase.source)
          || !["word", "clip"].includes(phrase.timing) || !Array.isArray(phrase.strokeIds)
          || phrase.strokeIds.length > MAX_DRAWING_STROKES) return false;
        phraseIds.add(phrase.id);
        textChars += phrase.text.length;
        if (textChars > MAX_DRAWING_VOICE_TEXT) return false;
        const refs = new Set<string>();
        for (const ref of phrase.strokeIds) {
          if (!identifier(ref) || !strokeIds.has(ref) || refs.has(ref)) return false;
          refs.add(ref);
        }
        if (phrase.source === "unlinked" && phrase.strokeIds.length) return false;
      }
    }
  }
  if (!Array.isArray(a.targetSamples) || a.targetSamples.length > MAX_DRAWING_TARGETS) return false;
  return [...a.targetSamples, ...(a.markerSample === undefined ? [] : [a.markerSample])].every(s => !!s && finite(s.t) && finite(s.x) && finite(s.y)
    && finite(s.scrollX) && finite(s.scrollY) && nullableText(s.elementPath) && nullableText(s.dataSource)
    && nullableText(s.label) && (s.container === undefined || nullableText(s.container))
    && (s.details === undefined || validDetails(s.details)));
}

/** Shared renderer for the interactive SVG layer and the exported screenshot. Values come from validated strokes. */
export function drawingSvg(strokes: readonly DrawingStroke[], width: number, height: number): string {
  const n = (v: number) => Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "0";
  const paths = (outline: boolean) => strokes.map(s => {
    const a = s.points[0], b = s.points.at(-1);
    if (!a || !b) return "";
    const color = drawingStrokeColor(s), width = drawingStrokeWidth(s);
    const stroke = `stroke="${outline ? drawingColorContrast(color) : color}" stroke-width="${n(width + (outline ? 3 : 0))}"`;
    const pattern = drawingDashArray(drawingStrokeStyle(s), width), dash = pattern === null ? "" : ` stroke-dasharray="${pattern}"`;
    if (s.tool === "rectangle") return `<rect x="${n(Math.min(a.x, b.x))}" y="${n(Math.min(a.y, b.y))}" width="${n(Math.abs(b.x - a.x))}" height="${n(Math.abs(b.y - a.y))}" rx="2" ${stroke}${dash}/>`;
    if (s.tool === "ellipse") return `<ellipse cx="${n((a.x + b.x) / 2)}" cy="${n((a.y + b.y) / 2)}" rx="${n(Math.abs(b.x - a.x) / 2)}" ry="${n(Math.abs(b.y - a.y) / 2)}" ${stroke}${dash}/>`;
    if (s.tool === "arrow") {
      const angle = Math.atan2(b.y - a.y, b.x - a.x), len = Math.min(Math.max(16, width * 4), Math.hypot(b.x - a.x, b.y - a.y) * .4);
      const wing = (offset: number) => `${n(b.x - len * Math.cos(angle + offset))} ${n(b.y - len * Math.sin(angle + offset))}`;
      const shaft = `M${n(a.x)} ${n(a.y)} L${n(b.x)} ${n(b.y)}`, head = `M${wing(.5)} L${n(b.x)} ${n(b.y)} L${wing(-.5)}`;
      // Arrowheads stay solid so the direction remains clear at every style and width.
      return pattern === null ? `<path d="${shaft} ${head}" ${stroke}/>` : `<g ${stroke}><path d="${shaft}"${dash}/><path d="${head}"/></g>`;
    }
    return `<path d="${s.points.map((p, i) => `${i ? "L" : "M"}${n(p.x)} ${n(p.y)}`).join(" ")}" ${stroke}${dash}/>`;
  }).join("");
  const badges = strokes.map(s => {
    const point = s.points[0];
    if (!point || !Number.isInteger(s.label) || s.label! <= 0 || s.label! > 1_000_000) return "";
    const label = String(s.label), badgeWidth = Math.min(width, Math.max(22, label.length * 7 + 12)), badgeHeight = Math.min(height, 22);
    const x = Math.max(0, Math.min(width - badgeWidth, point.x + 8));
    const y = Math.max(0, Math.min(height - badgeHeight, point.y - 26));
    const size = Math.min(12, badgeHeight * .6, badgeWidth / (label.length * .7));
    const color = drawingStrokeColor(s), contrast = drawingColorContrast(color);
    return `<g data-mark-label="${label}"><rect x="${n(x)}" y="${n(y)}" width="${n(badgeWidth)}" height="${n(badgeHeight)}" rx="${n(Math.min(11, badgeHeight / 2))}" fill="${color}" stroke="${contrast}" stroke-width="1"/><text x="${n(x + badgeWidth / 2)}" y="${n(y + badgeHeight / 2)}" font-size="${n(size)}" font-weight="700" text-anchor="middle" dominant-baseline="central" fill="${contrast}">${label}</text></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}"><g fill="none" stroke-linecap="round" stroke-linejoin="round">${paths(true)}</g><g fill="none" stroke-linecap="round" stroke-linejoin="round">${paths(false)}</g>${badges ? `<g data-drawing-labels="true" font-family="system-ui, sans-serif">${badges}</g>` : ""}</svg>`;
}
