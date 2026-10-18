import { describe, expect, it } from "vitest";
import { bubblePosition, insertAtCaret, targetName } from "./commentOverlay.ts";
import { isPageCommentAction } from "./pageBridge.ts";

describe("insertAtCaret", () => {
  it("inserts into an empty field", () => {
    expect(insertAtCaret("", 0, 0, " make it red ")).toEqual({ value: "make it red", caret: 11 });
  });
  it("adds a space where the words would touch", () => {
    expect(insertAtCaret("Hello", 5, 5, "world")).toEqual({ value: "Hello world", caret: 11 });
    expect(insertAtCaret("Hello there", 0, 0, "Oh")).toEqual({ value: "Oh Hello there", caret: 2 });
  });
  it("needs no space before punctuation or after whitespace", () => {
    expect(insertAtCaret("Make it . ", 7, 7, "bigger")).toEqual({ value: "Make it bigger . ", caret: 14 });
    expect(insertAtCaret("Make it.", 7, 7, " bigger")).toEqual({ value: "Make it bigger.", caret: 14 });
  });
  it("replaces the selection", () => {
    expect(insertAtCaret("make it red now", 8, 11, "blue")).toEqual({ value: "make it blue now", caret: 12 });
  });
  it("ignores empty dictation", () => {
    expect(insertAtCaret("abc", 1, 2, "  ")).toEqual({ value: "abc", caret: 2 });
  });
});

describe("bubblePosition", () => {
  const view = { sx: 0, sy: 100, vw: 1000, vh: 800 };
  it("goes below-right of the pin", () => {
    expect(bubblePosition(200, 300, 300, 170, view)).toEqual({ left: 210, top: 310 });
  });
  it("flips left and above near the viewport's right and bottom edges", () => {
    expect(bubblePosition(900, 850, 300, 170, view)).toEqual({ left: 590, top: 670 });
  });
  it("stays inside the viewport", () => {
    expect(bubblePosition(5, 105, 300, 170, view)).toEqual({ left: 15, top: 115 });
  });
});

describe("targetName", () => {
  it("uses the label, shortened", () => {
    expect(targetName({ label: "  Get   started ", elementPath: "button" })).toBe("Get started");
    expect(targetName({ label: "x".repeat(60), elementPath: "p" })).toHaveLength(40);
  });
  it("falls back to the tag", () => {
    expect(targetName({ label: null, elementPath: "body > main > div.card > IMG.hero" })).toBe("img");
    expect(targetName({ label: null, elementPath: null })).toBe("element");
  });
});

describe("isPageCommentAction", () => {
  it("accepts the bubble's actions", () => {
    expect(isPageCommentAction({ type: "comment.draft", open: true })).toBe(true);
    expect(isPageCommentAction({ type: "comment.record", on: false })).toBe(true);
    expect(isPageCommentAction({ type: "comment.send", text: "hi", sample: { elementPath: "button" } })).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isPageCommentAction(null)).toBe(false);
    expect(isPageCommentAction({ type: "comment.draft" })).toBe(false);
    expect(isPageCommentAction({ type: "comment.send", text: "hi", sample: { elementPath: null } })).toBe(false);
    expect(isPageCommentAction({ type: "thread.focus", threadId: "x" })).toBe(false);
  });
});
