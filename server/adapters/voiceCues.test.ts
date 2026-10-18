import { describe, expect, it } from "vitest";
import { buildRouterParams, solverUserMessage } from "./claude.ts";
import { FISH_ACK_CUES, FISH_SOLVER_CUES, useVoiceCues } from "./voiceCues.ts";

describe("voice cues", () => {
  it("are used only for Drama 3 in English", () => {
    expect(useVoiceCues("fish_drama_3", "en")).toBe(true);
    expect(useVoiceCues("fish_drama_3", undefined)).toBe(true);
    expect(useVoiceCues("fish_drama_3", "ro")).toBe(false);
    expect(useVoiceCues("eleven_v4_turbo", "en")).toBe(false);
    expect(useVoiceCues("openai_tts_1", "en")).toBe(false);
  });

  it("the solver message carries the cue block only when asked", () => {
    const on = solverUserMessage("Why is the grid wide?", [], "question", undefined, "en", true);
    const off = solverUserMessage("Why is the grid wide?", [], "question", undefined, "en", false);
    expect(on).toContain(FISH_SOLVER_CUES);
    expect(off).not.toContain("Fish Audio Drama 3");
  });

  it("the router message carries the ack cue only when asked", () => {
    const on = buildRouterParams("move this", [], "auto", [], { voiceCues: true });
    const off = buildRouterParams("move this", [], "auto", [], {});
    const text = (p: { messages: { content: unknown }[] }) => String(p.messages.at(-1)!.content);
    expect(text(on as never)).toContain(FISH_ACK_CUES);
    expect(text(off as never)).not.toContain("Fish Audio Drama 3");
  });

  it("filler lines get the long-sentence cues only for Drama 3", async () => {
    const { buildFillersParams } = await import("./claude.ts");
    const on = buildFillersParams("move this", "Move it", "task", [], "en", true);
    const off = buildFillersParams("move this", "Move it", "task", [], "en", false);
    const text = (p: { messages: { content: unknown }[] }) => String(p.messages.at(-1)!.content);
    expect(text(on)).toContain("ONE long sentence of 12 to 18 words");
    expect(text(off)).not.toContain("Fish Audio Drama 3");
  });

  it("the solver prompt asks for short spoken lines", async () => {
    const { readFileSync } = await import("node:fs");
    const { SERVER_DIR } = await import("../paths.ts");
    const text = readFileSync(`${SERVER_DIR}prompts/solver.md`, "utf8");
    expect(text).toContain("under 25 words");
    expect(text).toContain("SPOKEN: <one or two short sentences, under 25 words>");
  });
});
