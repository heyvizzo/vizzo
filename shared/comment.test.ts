import { describe, expect, it } from "vitest";
import { computeRests } from "./pointing.ts";
import type { CursorSample } from "./protocol.ts";
import { TYPED_WORD_MS, typedSpanMs, typedWords } from "./comment.ts";

describe("typed comments", () => {
  it("lays the words out one every TYPED_WORD_MS", () => {
    expect(typedWords("  make  this bigger ")).toEqual([
      { text: "make", start: 0, end: 0.25 },
      { text: "this", start: 0.3, end: 0.55 },
      { text: "bigger", start: 0.6, end: 0.85 },
    ]);
    expect(typedSpanMs("make this bigger")).toBe(3 * TYPED_WORD_MS);
    expect(typedSpanMs("")).toBe(TYPED_WORD_MS);
  });

  it("samples on the clicked element across the span make it a whole-utterance rest", () => {
    const text = "round the corners more";
    const tPress = 10_000;
    const at: CursorSample = { t: 0, x: 5, y: 5, scrollX: 0, scrollY: 0, elementPath: "body > button.cta", dataSource: null, label: "Get started" };
    const samples: CursorSample[] = [];
    for (let t = tPress; t <= tPress + typedSpanMs(text); t += 100) samples.push({ ...at, t });
    const rests = computeRests(typedWords(text), tPress, samples);
    expect(rests).toHaveLength(1);
    expect(rests[0]).toMatchObject({ whole: true, sample: { elementPath: "body > button.cta" } });
  });
});
