import type { DrawingAnnotation } from "../../shared/annotations.ts";
export const annotation: DrawingAnnotation = {
  version: 1, id: "drawing-test", pageUrl: "http://localhost:3000", createdAt: 1,
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 20 },
  strokes: [{ id: "s1", tool: "arrow", points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] }],
  targetSamples: [{ t: 1, x: 30, y: 40, scrollX: 0, scrollY: 20, elementPath: "body > button", dataSource: "Button.tsx:12", label: "Save" }],
  image: { width: 800, height: 600, dataUrl: "data:image/png;base64,aGVsbG8=" },
};
