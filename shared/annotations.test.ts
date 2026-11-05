import { describe, expect, it } from "vitest";
import { drawingSvg, isDrawingAnnotation, MAX_DRAWING_IMAGE_CHARS, MAX_DRAWING_POINTS, MAX_DRAWING_STROKES, type DrawingAnnotation } from "./annotations.ts";

const annotation = (): DrawingAnnotation => ({
  version: 1, id: "drawing-1", pageUrl: "http://localhost:3000/", createdAt: 123,
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 100 },
  image: { dataUrl: "data:image/png;base64,aGVsbG8=", width: 800, height: 600 },
  strokes: [{ id: "s1", tool: "arrow", points: [{ x: 10, y: 20 }, { x: 200, y: 100 }] }],
  targetSamples: [{ t: 123, x: 10, y: 20, scrollX: 0, scrollY: 100, elementPath: "body > button", dataSource: null, label: "Save" }],
});

describe("drawing attachment boundary", () => {
  it("accepts the same captured geometry at a different exported image size", () => {
    const a = annotation();
    a.image.width = 400; a.image.height = 300;
    expect(isDrawingAnnotation(a)).toBe(true);
    a.targetSamples = [];
    expect(isDrawingAnnotation(a)).toBe(true);
  });
  it("rejects malformed attachments without throwing", () => {
    for (const a of [null, undefined, {}, [], { ...annotation(), viewport: null }, { ...annotation(), image: null },
      { ...annotation(), strokes: [null] }, { ...annotation(), targetSamples: [null] }, { ...annotation(), version: 2 }]) {
      expect(isDrawingAnnotation(a)).toBe(false);
    }
  });
  it("bounds geometry and rejects values that cannot be rendered", () => {
    for (const x of [NaN, Infinity, -1, 801]) {
      const a = annotation(); a.strokes[0]!.points[0]!.x = x;
      expect(isDrawingAnnotation(a)).toBe(false);
    }
    const a = annotation(); a.viewport.height = 0;
    expect(isDrawingAnnotation(a)).toBe(false);
  });
  it("only accepts bounded raster data URLs", () => {
    for (const url of ["https://example.com/image.png", "data:image/svg+xml;base64,aGVsbG8=", "data:image/png;base64,", "data:image/png;base64,<script>", "data:image/jpeg;base64," + "a".repeat(MAX_DRAWING_IMAGE_CHARS)]) {
      const a = annotation(); a.image.dataUrl = url;
      expect(isDrawingAnnotation(a)).toBe(false);
    }
  });
  it("bounds total stroke and point counts", () => {
    const a = annotation(); a.strokes = Array.from({ length: MAX_DRAWING_STROKES + 1 }, () => a.strokes[0]!);
    expect(isDrawingAnnotation(a)).toBe(false);
    const b = annotation(); b.strokes[0]!.points = Array.from({ length: MAX_DRAWING_POINTS + 1 }, () => ({ x: 10, y: 20 }));
    expect(isDrawingAnnotation(b)).toBe(false);
  });
  it("rejects malformed nested element metadata before prompt formatting", () => {
    const a = annotation();
    Object.assign(a.targetSamples[0]!, { details: { selector: "button", styles: null } });
    expect(isDrawingAnnotation(a)).toBe(false);
    const b = annotation();
    Object.assign(b.targetSamples[0]!, { label: { unexpected: true } });
    expect(isDrawingAnnotation(b)).toBe(false);
  });
});

describe("drawing image geometry", () => {
  it("normalizes rectangles and ellipses dragged up and left", () => {
    const points = [{ x: 100, y: 80 }, { x: 20, y: 10 }];
    const svg = drawingSvg([{ id: "r", tool: "rectangle", points }, { id: "e", tool: "ellipse", points }], 800, 600);
    expect(svg).toContain('viewBox="0 0 800 600"');
    expect(svg).toContain('<rect x="20" y="10" width="80" height="70"');
    expect(svg).toContain('<ellipse cx="60" cy="45" rx="40" ry="35"');
  });
  it("keeps pen geometry and draws arrowheads in the endpoint direction", () => {
    const svg = drawingSvg([
      { id: "p", tool: "pen", points: [{ x: 10, y: 10 }, { x: 12, y: 20 }, { x: 30, y: 40 }] },
      { id: "a", tool: "arrow", points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    ], 200, 100);
    expect(svg).toContain('M10 10 L12 20 L30 40');
    expect(svg).toContain('M0 0 L100 0 M85.96 -7.67 L100 0 L85.96 7.67');
    expect(svg).not.toMatch(/NaN|Infinity|undefined/);
  });
});
