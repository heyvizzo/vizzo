import { describe, expect, it } from "vitest";
import { drawingAnchor, inferAnchor } from "../../shared/anchor.ts";
import { markerPoint, resolveAnchor } from "../cursor/threadOverlay.ts";
import type { DrawingAnnotation } from "../../shared/annotations.ts";
import { isPageCommentAction } from "../cursor/pageBridge.ts";
import { queuedAnchor, queuedThreads, shiftMsg, type TurnMsg } from "./queue.ts";

const annotation = (): DrawingAnnotation => ({
  version: 1, id: "captured", pageUrl: "https://example.test/original#section", createdAt: 100,
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 200 },
  image: { dataUrl: "data:image/png;base64,aGVsbG8=", width: 800, height: 600 },
  strokes: [{ id: "arrow", tool: "arrow", points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] }],
  targetSamples: [{ t: 100, x: 10, y: 20, scrollX: 0, scrollY: 200, elementPath: "body > button", label: "Save", dataSource: null }],
});

describe("drawing comments", () => {
  it("accepts a page drawing without a synthetic element sample", () => {
    expect(isPageCommentAction({ type: "comment.send", text: "Move these", sample: null, annotation: annotation() })).toBe(true);
    expect(isPageCommentAction({ type: "comment.send", text: "Move these", sample: null })).toBe(false);
    expect(isPageCommentAction({ type: "comment.send", text: "Move these", annotation: annotation() })).toBe(false);
  });
  it("rejects a malformed attachment even when a valid element is supplied", () => {
    for (const sample of [null, { elementPath: "button" }]) {
      for (const bad of [null, {}, { ...annotation(), image: { dataUrl: "javascript:alert(1)", width: 800, height: 600 } }]) {
        expect(isPageCommentAction({ type: "comment.send", text: "hi", sample, annotation: bad })).toBe(false);
      }
    }
  });
  it("keeps ordinary element comments and thread followups backward compatible", () => {
    expect(isPageCommentAction({ type: "comment.send", text: "hi", sample: { elementPath: "button" }, threadId: "thread-1" })).toBe(true);
  });
});

describe("queued drawing retention", () => {
  it("shifts release clocks without changing captured image, target times or geometry", () => {
    const a = annotation();
    const captured = structuredClone(a);
    const msg: TurnMsg = { type: "turn.start", turnId: "a", config: {} as never, tPress: 10, annotation: a, pageUrl: a.pageUrl };
    const shifted = shiftMsg(msg, 900);
    expect(shifted).toMatchObject({ tPress: 910, pageUrl: captured.pageUrl, annotation: captured });
    expect(shifted.type === "turn.start" && shifted.annotation).toBe(a);
    expect(msg.tPress).toBe(10);
    expect(a).toEqual(captured);
    // Drawing markers use captured geometry even without an element sample.
    expect(queuedAnchor([{ msg }])).toMatchObject({
      kind: "drawing", pageUrl: "https://example.test/original",
      bounds: { x: 10, y: 220, width: 20, height: 20 }, point: { x: 20, y: 230 },
    });
  });
  it("preserves per-message images when element feedback groups into a thread", () => {
    const first = annotation(), second = { ...annotation(), id: "second" };
    const anchor = { pageUrl: first.pageUrl, selector: "button", domPath: "body > button", dataSource: null, label: "Save", text: "Save", role: null, tag: "button", bounds: { x: 0, y: 0, width: 10, height: 10 } };
    const [thread] = queuedThreads([
      { turnId: "first", anchor, text: "Move it", at: 100, annotation: first },
      { turnId: "second", anchor, text: "Like this", at: 101, annotation: second },
      { turnId: "plain", anchor, text: "And bigger", at: 102 },
    ]);
    expect(thread!.messages.map(m => m.annotation)).toEqual([first, second, undefined]);
    expect(thread!.messages[0]!.annotation).toBe(first);
    expect(thread!.messages[1]!.kind).toBe("followup");
  });
});

describe("drawing marker geometry", () => {
  it("centers the enclosing box of every mark, independent of element targets", () => {
    const a = annotation();
    a.viewport.scrollX = 50;
    a.strokes = [
      { id: "box", tool: "rectangle", points: [{ x: 200, y: 300 }, { x: 100, y: 100 }] },
      { id: "pen", tool: "pen", points: [{ x: 10, y: 150 }, { x: 400, y: 50 }, { x: 20, y: 200 }] },
      { id: "oval", tool: "ellipse", points: [{ x: 250, y: 400 }, { x: 300, y: 200 }] },
    ];
    const anchor = inferAnchor({ annotation: a, words: [], pointing: [], rests: [], samples: a.targetSamples, pageUrl: a.pageUrl })!;
    expect(anchor.bounds).toEqual({ x: 60, y: 250, width: 390, height: 350 });
    expect(markerPoint(anchor, null)).toEqual({ x: 255, y: 425 });
    expect(resolveAnchor(anchor, null)).toBeNull();
    expect(drawingAnchor(a)).toEqual(anchor);
  });
  it("handles a single point and ignores empty strokes", () => {
    const a = annotation();
    a.strokes = [{ id: "empty", tool: "pen", points: [] }, { id: "dot", tool: "pen", points: [{ x: 12, y: 34 }] }];
    expect(drawingAnchor(a)?.point).toEqual({ x: 12, y: 234 });
    a.strokes = [];
    expect(drawingAnchor(a)).toBeNull();
  });
});

describe("drawing element anchors", () => {
  it("follows the captured element when it moves and resizes", () => {
    const a = annotation();
    a.markerSample = {
      ...a.targetSamples[0]!,
      details: { selector: "#card", domPath: "body > section#card", tag: "section", classes: [], attrs: {}, text: "Card", styles: {}, html: "<section></section>", viewport: { width: 800, height: 600 }, bounds: { x: 0, y: 0, width: 100, height: 100 } },
    };
    const anchor = drawingAnchor(a)!;
    expect(anchor.selector).toBe("#card");
    expect(anchor.point).toEqual({ x: 20, y: 230 });
    expect(markerPoint(anchor, { x: 300, y: 500, width: 200, height: 50 })).toEqual({ x: 340, y: 515 });
    expect(queuedAnchor([{ msg: { type: "turn.start", turnId: "drawing", tPress: 0, config: {} as never, annotation: a } }])).toEqual(anchor);
  });
});
