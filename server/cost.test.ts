import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type RunConfig } from "../shared/config.ts";
import { callCost, computeCost, costBreakdown, costItems, haikuCost, opusCost, realtimeCost, realtimeResponseCost } from "./cost.ts";

const cfg = (o: Partial<RunConfig> = {}): RunConfig => ({ ...DEFAULT_CONFIG, ...o });

describe("cost", () => {
  it("Haiku: input, output, cache read/write", () => {
    // 1000 in × 0.10 + 200 out × 0.50 + 2000 read × 0.01 + 400 write × 0.125 = 100 + 100 + 20 + 50 = 270 per M
    expect(haikuCost({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 2000, cache_creation_input_tokens: 400 })).toBeCloseTo(270e-6, 12);
  });

  it("Haiku: long-prompt tier above 100K input", () => {
    // 120000 × 0.50 + 1000 × 2.50 = 60000 + 2500 = 62500 per M
    expect(haikuCost({ input_tokens: 120_000, output_tokens: 1000 })).toBeCloseTo(0.0625, 10);
  });

  it("Opus standard vs fast (from usage.speed, falling back to config)", () => {
    const u = { input_tokens: 500, output_tokens: 1000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 };
    // standard: 500×4 + 1000×20 + 10000×0.20 = 2000 + 20000 + 2000 = 24000 per M
    expect(opusCost({ ...u, speed: "standard" }, true)).toBeCloseTo(0.024, 10);
    // fast: 500×8 + 1000×40 + 10000×0.40 = 4000 + 40000 + 4000 = 48000 per M
    expect(opusCost({ ...u, speed: "fast" }, false)).toBeCloseTo(0.048, 10);
    expect(opusCost(u, true)).toBeCloseTo(0.048, 10);
    expect(opusCost(u, false)).toBeCloseTo(0.024, 10);
    // cache write: 1000 × 4 × 1.25 = 5000 per M
    expect(opusCost({ cache_creation_input_tokens: 1000 }, false)).toBeCloseTo(0.005, 10);
  });

  it("Realtime full and mini, cached tokens billed at the cached rate", () => {
    const usage = { responses: [], totals: { inputText: 1000, inputAudio: 2000, cachedText: 400, cachedAudio: 500, outputText: 100, outputAudio: 1500 } };
    // full: 600×4 + 1500×32 + 900×0.40 + 100×24 + 1500×64 = 2400 + 48000 + 360 + 2400 + 96000 = 149160 per M
    expect(realtimeCost(usage, "gpt-realtime-2.1")).toBeCloseTo(0.14916, 10);
    // mini: 600×0.6 + 1500×10 + 900×0.3 + 100×2.4 + 1500×20 = 360 + 15000 + 270 + 240 + 30000 = 45870 per M
    expect(realtimeCost(usage, "gpt-realtime-2.1-mini")).toBeCloseTo(0.04587, 10);
  });

  it("ElevenLabs TTS chars and Scribe seconds", () => {
    const b = costBreakdown(cfg(), { elevenChars: 250, scribeSeconds: 36 });
    expect(b.tts).toBeCloseTo(0.01, 10); // 250 × 0.04/1000
    expect(b.stt).toBeCloseTo(0.0039, 10); // 36 s × 0.39/3600
    expect(b.total).toBeCloseTo(0.0139, 10);
  });

  it("sums a whole pipeline turn and tolerates junk", () => {
    const total = computeCost(cfg({ opusFast: false }), {
      anthropic: { haiku: { input_tokens: 1000, output_tokens: 200 }, opus: { input_tokens: 500, output_tokens: 1000, speed: "standard" } },
      elevenChars: 100,
      scribeSeconds: 3.6,
    });
    // haiku 200e-6 + opus (2000+20000)e-6 + tts 0.004 + stt 0.00039
    expect(total).toBeCloseTo(200e-6 + 0.022 + 0.004 + 0.00039, 10);
    expect(computeCost(cfg(), {})).toBe(0);
    expect(computeCost(cfg(), { anthropic: "nope", openai: 42, elevenChars: Number.NaN })).toBe(0);
  });
});

describe("progress lines", () => {
  it("the Haiku call that writes them is billed with the router", () => {
    const fillers = { input_tokens: 346, output_tokens: 85, cache_creation_input_tokens: 809, cache_read_input_tokens: 0 };
    const b = costBreakdown(DEFAULT_CONFIG, { anthropic: { fillers } });
    // 346 × $0.10 + 809 × $0.125 (cache write) + 85 × $0.50, per million
    expect(b.haiku).toBeCloseTo((346 * 0.1 + 809 * 0.125 + 85 * 0.5) / 1e6, 10);
  });
});

describe("itemized and per-call costs", () => {
  it("costItems sum to computeCost and name each part", () => {
    const usage = {
      anthropic: {
        haiku: { input_tokens: 300, output_tokens: 170, cache_read_input_tokens: 2200 },
        fillers: { input_tokens: 346, output_tokens: 85, cache_creation_input_tokens: 809 },
        opus: { input_tokens: 134, output_tokens: 769, cache_read_input_tokens: 10_214, speed: "standard" },
      },
      elevenChars: 260, elevenSegments: [{ label: "ack", chars: 40 }, { label: "filler", chars: 41 }, { label: "answer", chars: 179 }],
      scribeSeconds: 2.2,
    };
    const items = costItems(DEFAULT_CONFIG, usage);
    expect(items.map((i) => i.label)).toEqual(["Haiku router", "Haiku progress lines", "Opus", "ElevenLabs TTS (eleven_v4_turbo)", "Scribe STT"]);
    expect(items.reduce((n, i) => n + i.usd, 0)).toBeCloseTo(computeCost(DEFAULT_CONFIG, usage), 12);
    expect(items[3]!.detail).toBe("ack 40 · filler 41 · answer 179 chars");
  });

  it("prices one raw Realtime response (cached text, audio in/out)", () => {
    const raw = { input_tokens: 1336, output_tokens: 159, input_token_details: { text_tokens: 1324, audio_tokens: 12, cached_tokens: 896, cached_tokens_details: { text_tokens: 896, audio_tokens: 0 } }, output_token_details: { text_tokens: 60, audio_tokens: 99 } };
    // gpt-realtime-2.1: text in $4, audio in $32, cached $0.40, text out $24, audio out $64 per M
    const expected = ((1324 - 896) * 4 + 12 * 32 + 896 * 0.4 + 60 * 24 + 99 * 64) / 1e6;
    expect(realtimeResponseCost(raw, "gpt-realtime-2.1")).toBeCloseTo(expected, 12);
    expect(callCost("realtime", raw, "gpt-realtime-2.1")).toBeCloseTo(expected, 12);
    expect(callCost("router", null, "gpt-realtime-2.1")).toBe(0);
  });
});
