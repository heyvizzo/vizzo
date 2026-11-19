// Geometry shared by the marker in the document and its floating panel.
import type { ThreadAnchor } from "../../shared/threads.ts";
import type { Tone } from "./colors.ts";

export const MARKER = 20;
/** The bubble's tail: a rotated square of this side whose tip sits about TAIL_REACH px below the bubble. */
export const TAIL = 10;
export const TAIL_REACH = 7;
/** The bubble's and panel's right edge sits this far right of the marker's center, so the tail clears the corner. */
export const OVERHANG = 16;
/** Vertical room between a marker's edge and a bubble or panel: the tail plus a hair. */
export const TAIL_GAP = TAIL_REACH + 2;
export const PANEL_WIDTH = 340;
export const PANEL_HEIGHT = 420;
export const PANEL_MIN_WIDTH = 280;
export const PANEL_MIN_HEIGHT = 220;
export const PANEL_GAP = 8;

export interface MarkerGeometry {
  x: number; y: number; radius: number; vw: number; vh: number; scrollX: number; scrollY: number; tone: Tone; resolved: boolean;
}
/** Where a bubble or panel points: a marker (document coords) or the orb (viewport coords: `fixed`). */
export interface Spot { x: number; y: number; r: number; fixed: boolean }
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

/**
 * Where the panel goes (document coords) for a marker at (mx, my): below it, its right edge just past the marker,
 * kept inside the viewport (scrolled by sx, sy, size vw × vh); above the marker when there's no room below.
 * `radius`: the marker's (the orb is bigger).
 * `tailRight` places the tail (from the panel's right edge) so it points at the marker.
 */
export function panelPosition(
  mx: number, my: number, height: number, view: { sx: number; sy: number; vw: number; vh: number }, radius = MARKER / 2, width = PANEL_WIDTH,
): { left: number; top: number; side: "below" | "above"; tailRight: number } {
  const left = Math.max(view.sx + PANEL_GAP, Math.min(mx + OVERHANG - width, view.sx + view.vw - width - PANEL_GAP));
  const below = my + radius + TAIL_GAP;
  const above = my - radius - TAIL_GAP - height;
  const side = below + height <= view.sy + view.vh || above < view.sy ? "below" : "above";
  return { left, top: side === "below" ? below : above, side, tailRight: tailOffset(left + width, mx, width) };
}

/** The tail's offset from a box's right edge (at `right`, `width` wide) so it points at x, kept off the corners. */
export function tailOffset(right: number, x: number, width: number): number {
  return Math.max(8, Math.min(right - x - TAIL / 2, width - TAIL - 8));
}
