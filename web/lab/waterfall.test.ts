import { describe, expect, it } from "vitest";
import { buildWaterfall, niceTicks } from "./waterfall.ts";

describe("niceTicks", () => {
  it("covers the range with 1/2/5 steps", () => {
    const t = niceTicks(-420, 3150);
    expect(t.min).toBeLessThanOrEqual(-420);
    expect(t.max).toBeGreaterThanOrEqual(3150);
    expect(t.ticks).toContain(0);
    const step = t.ticks[1]! - t.ticks[0]!;
    expect([100, 200, 500, 1000]).toContain(step);
  });
});

describe("buildWaterfall", () => {
  const marks = {
    press: 0, release: 1500, "stt.firstPartial": 900, "stt.final": 1700, "pointing.resolved": 1703, "llm.request": 1705,
    "llm.firstToken": 2000, "llm.toolCall": 2060, "ack.ttsFirstByte": 2200, "ack.played": 2260, "opus.request": 2100,
    "opus.firstToken": 3100, "opus.spokenReady": 3800, "opus.done": 6000, "answer.ttsFirstByte": 4000, "answer.played": 4070, "turn.end": 6100,
  };
  it("pipeline: rows relative to release with vendor colours", () => {
    const wf = buildWaterfall(marks, "pipeline");
    const row = (l: string) => wf.rows.find((r) => r.label === l)!;
    expect(row("Speech (hold)").segments[0]).toMatchObject({ from: -1500, to: 0 });
    expect(row("STT final").vendor).toBe("elevenlabs");
    expect(row("STT final").segments[0]).toMatchObject({ from: -600, to: 0, faint: true });
    expect(row("STT final").value).toBe(200);
    expect(row("Voice LLM").vendor).toBe("anthropic");
    expect(row("Ack TTS").vendor).toBe("elevenlabs");
    expect(row("Opus").vendor).toBe("anthropic");
    expect(row("Opus").ticks).toHaveLength(2);
    expect(row("Answer playback").value).toBe(2570);
    expect(wf.refs.map((r) => r.label)).toEqual(["release", "TTFA", "TTA", "end"]);
    expect(wf.min).toBeLessThanOrEqual(-1500);
    expect(wf.max).toBeGreaterThanOrEqual(4600);
  });
  it("realtime: OpenAI for LLM and TTS; missing stages omitted", () => {
    const wf = buildWaterfall({ press: 0, release: 1000, "llm.request": 1005, "llm.firstToken": 1400, "ack.ttsFirstByte": 1402 }, "realtime");
    expect(wf.rows.map((r) => r.label)).toEqual(["Speech (hold)", "Voice LLM", "Ack TTS"]);
    expect(wf.rows[1]!.vendor).toBe("openai");
  });
  it("live: open bars run to now", () => {
    const wf = buildWaterfall({ press: 0, release: 1000, "llm.request": 1010 }, "pipeline", 1500);
    const llm = wf.rows.find((r) => r.label === "Voice LLM")!;
    expect(llm.segments[0]).toMatchObject({ from: 10, to: 500, open: true });
  });
});
