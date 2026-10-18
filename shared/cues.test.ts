import { describe, expect, it } from "vitest";
import { stripVoiceCues } from "./cues.ts";

describe("stripVoiceCues", () => {
  it("drops directions and tags, keeping the words", () => {
    expect(stripVoiceCues("[pointing it out, friendly] Click <emphasis>this</emphasis> button.")).toBe("Click this button.");
    expect(stripVoiceCues("[thinking hard] <slow>Hmmm, the cache</slow> [small laugh] is it.")).toBe("Hmmm, the cache is it.");
  });
  it("hides a cue still streaming in", () => {
    expect(stripVoiceCues("Done. [warm, pl")).toBe("Done.");
    expect(stripVoiceCues("Click <emph")).toBe("Click");
  });
  it("leaves plain text alone", () => {
    expect(stripVoiceCues("Line one.\nLine two.")).toBe("Line one.\nLine two.");
  });
});
