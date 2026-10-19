import { describe, expect, it } from "vitest";
import { hasSpokenWords, isNoSpeechNote } from "./speech.ts";

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

  it("rejects a recognizer's no-speech note, as text or as words", () => {
    expect(hasSpokenWords("(nothing heard)")).toBe(false);
    expect(hasSpokenWords("", [{ text: "[BLANK_AUDIO]" }])).toBe(false);
    expect(hasSpokenWords("(nothing heard)", [{ text: "(nothing" }, { text: "heard)" }])).toBe(false);
  });
});

describe("isNoSpeechNote", () => {
  it("recognizes notes that nothing was said", () => {
    for (const t of [
      "(nothing heard)", "[BLANK_AUDIO]", "[silence]", "(Silence.)", "No speech detected.", "nothing heard",
      "[no audio]", "(The audio is silent.)", "[music]", "(coughs)", "[Music] [Applause]", "*background noise*",
      "♪ [music playing] ♪", "<silence>", "[ Silence ]", "(liniște)",
    ]) expect(isNoSpeechNote(t), t).toBe(true);
  });

  it("leaves real speech and unclear-speech notes to the router", () => {
    for (const t of [
      "", "hello", "make this bigger", "make this bigger [BLANK_AUDIO]", "(unintelligible)", "[inaudible]",
      "unintelligible words", "(mumbling)", "music", "silence the alerts", "nothing", "no", "silence", "empty", "nimic", "[foreign language]",
    ]) expect(isNoSpeechNote(t), t).toBe(false);
  });
});
