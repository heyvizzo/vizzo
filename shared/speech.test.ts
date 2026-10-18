import { describe, expect, it } from "vitest";
import { hasSpokenWords } from "./speech.ts";

describe("hasSpokenWords", () => {
  it("accepts a transcript or a word list that contains a real word", () => {
    expect(hasSpokenWords("hello there")).toBe(true);
    expect(hasSpokenWords("", [{ text: "da" }])).toBe(true);
    expect(hasSpokenWords("ăsta", [])).toBe(true);
  });

  it("rejects empty, whitespace and punctuation-only clips", () => {
    expect(hasSpokenWords("")).toBe(false);
    expect(hasSpokenWords("   ")).toBe(false);
    expect(hasSpokenWords("...", [{ text: "..." }, { text: "" }])).toBe(false);
    expect(hasSpokenWords("hello", [{ text: "..." }])).toBe(false);
  });
});
