import { drawingStrokeWidth, type DrawingPoint, type DrawingStroke } from "../../shared/annotations.ts";

export interface DrawingBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
export interface DrawingViewport { width: number; height: number }

const bounds = (left: number, top: number, right: number, bottom: number): DrawingBounds =>
  ({ left, top, right, bottom, width: right - left, height: bottom - top });

/** Point bounds, excluding ink thickness, arrowheads and the number badge. */
export function strokeBounds(stroke: DrawingStroke): DrawingBounds {
  if (!stroke.points.length) return bounds(0, 0, 0, 0);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of stroke.points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return bounds(left, top, right, bottom);
}

export function selectionBounds(strokes: readonly DrawingStroke[], ids: ReadonlySet<string>): DrawingBounds | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  let found = false;
  for (const stroke of strokes) {
    if (!ids.has(stroke.id) || !stroke.points.length) continue;
    const box = strokeBounds(stroke);
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.right);
    bottom = Math.max(bottom, box.bottom);
    found = true;
  }
  return found ? bounds(left, top, right, bottom) : null;
}

function segmentDistance(point: DrawingPoint, a: DrawingPoint, b: DrawingPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

/** Badge dimensions and placement mirror drawingSvg, including clamping at the captured viewport edges. */
function hitBadge(stroke: DrawingStroke, point: DrawingPoint, tolerance: number, viewport?: DrawingViewport): boolean {
  const origin = stroke.points[0];
  if (!origin || !Number.isInteger(stroke.label) || stroke.label! <= 0 || stroke.label! > 1_000_000) return false;
  const label = String(stroke.label);
  const width = viewport ? Math.min(viewport.width, Math.max(22, label.length * 7 + 12)) : Math.max(22, label.length * 7 + 12);
  const height = viewport ? Math.min(viewport.height, 22) : 22;
  const x = viewport ? Math.max(0, Math.min(viewport.width - width, origin.x + 8)) : origin.x + 8;
  const y = viewport ? Math.max(0, Math.min(viewport.height - height, origin.y - 26)) : origin.y - 26;
  return point.x >= x - tolerance && point.x <= x + width + tolerance
    && point.y >= y - tolerance && point.y <= y + height + tolerance;
}

function hitInk(stroke: DrawingStroke, point: DrawingPoint, tolerance: number): boolean {
  const a = stroke.points[0], b = stroke.points.at(-1);
  if (!a || !b) return false;
  const radius = tolerance + drawingStrokeWidth(stroke) / 2;
  if (stroke.tool === "rectangle") {
    return point.x >= Math.min(a.x, b.x) - radius && point.x <= Math.max(a.x, b.x) + radius
      && point.y >= Math.min(a.y, b.y) - radius && point.y <= Math.max(a.y, b.y) + radius;
  }
  if (stroke.tool === "ellipse") {
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
    if (!rx || !ry) return segmentDistance(point, a, b) <= radius;
    return ((point.x - cx) / (rx + radius)) ** 2 + ((point.y - cy) / (ry + radius)) ** 2 <= 1;
  }
  if (stroke.tool === "arrow") {
    if (segmentDistance(point, a, b) <= radius) return true;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const length = Math.min(Math.max(16, drawingStrokeWidth(stroke) * 4), Math.hypot(b.x - a.x, b.y - a.y) * .4);
    for (const offset of [.5, -.5]) {
      const wing = { x: b.x - length * Math.cos(angle + offset), y: b.y - length * Math.sin(angle + offset) };
      if (segmentDistance(point, b, wing) <= radius) return true;
    }
    return false;
  }
  if (stroke.points.length === 1) return Math.hypot(point.x - a.x, point.y - a.y) <= radius;
  for (let i = 1; i < stroke.points.length; i++) {
    if (segmentDistance(point, stroke.points[i - 1]!, stroke.points[i]!) <= radius) return true;
  }
  return false;
}

/** Badges are above all ink; within each SVG layer the last drawn stroke wins. Shape interiors are selectable. */
export function hitDrawingStroke(
  strokes: readonly DrawingStroke[], point: DrawingPoint, tolerance: number, viewport?: DrawingViewport,
): DrawingStroke | null {
  const margin = Number.isFinite(tolerance) ? Math.max(0, tolerance) : 0;
  // SVG draws every badge above every ink path, regardless of the stroke creation order.
  for (let i = strokes.length - 1; i >= 0; i--) {
    const stroke = strokes[i]!;
    if (hitBadge(stroke, point, margin, viewport)) return stroke;
  }
  for (let i = strokes.length - 1; i >= 0; i--) {
    const stroke = strokes[i]!;
    if (hitInk(stroke, point, margin)) return stroke;
  }
  return null;
}

/** Translate from the original snapshot; every selected mark receives one shared clamped delta. */
export function translateDrawingSelection(
  strokes: readonly DrawingStroke[], ids: ReadonlySet<string>, dx: number, dy: number, width: number, height: number,
): DrawingStroke[] {
  const box = selectionBounds(strokes, ids);
  if (!box || !Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(width) || !Number.isFinite(height)
    || width < 0 || height < 0) return strokes as DrawingStroke[];
  const x = Math.max(-box.left, Math.min(width - box.right, dx));
  const y = Math.max(-box.top, Math.min(height - box.bottom, dy));
  if (!x && !y) return strokes as DrawingStroke[];
  return strokes.map(stroke => ids.has(stroke.id)
    ? { ...stroke, points: stroke.points.map(point => ({ x: point.x + x, y: point.y + y })) }
    : stroke);
}
