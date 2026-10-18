import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, llmOf, type RunConfig } from "../shared/config.ts";
import { callCost, computeCost, costBreakdown, costItems, haikuCost, llmCallCost, opusCost } from "./cost.ts";
import { setPriceCatalog } from "./prices.ts";

/** DEFAULT_CONFIG: both tiers on Claude Code (subscription). */
const cfg = (o: Partial<RunConfig> = {}): RunConfig => ({ ...DEFAULT_CONFIG, ...o });
/** The fast tier on OhMyPi (billed through its API keys: calls carry their own llmCost), the smart one on Claude Code. */
const OMP: RunConfig = cfg({ llm: { fast: { provider: "omp", model: "cerebras/gpt-oss-120b", level: "low" }, smart: DEFAULT_CONFIG.llm.smart } });
const billed = (usd: number, o: Record<string, number> = {}) => ({ input_tokens: 300, output_tokens: 80, ...o, llmCost: { usd, billing: "api" } });

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

  it("ElevenLabs TTS chars and Scribe seconds", () => {
    const b = costBreakdown(cfg(), { elevenChars: 250, scribeSeconds: 36 });
    expect(b.tts).toBeCloseTo(0.01, 10); // 250 × 0.04/1000
    expect(b.stt).toBeCloseTo(0.0039, 10); // 36 s × 0.39/3600
    expect(b.total).toBeCloseTo(0.0139, 10);
  });

  it("sums a whole pipeline turn and tolerates junk", () => {
    const total = computeCost(OMP, {
      anthropic: { router: billed(0.0002), solver: { input_tokens: 500, output_tokens: 1000, speed: "standard" } },
      elevenChars: 100,
      scribeSeconds: 3.6,
    });
    // router (OhMyPi, billed) 0.0002 + solver on Claude Code ($0, subscription) + tts 0.004 + stt 0.00039
    expect(total).toBeCloseTo(0.0002 + 0.004 + 0.00039, 10);
    expect(computeCost(cfg(), {})).toBe(0);
    expect(computeCost(cfg(), { anthropic: "nope", elevenChars: Number.NaN })).toBe(0);
  });
});

describe("progress lines", () => {
  it("are billed with the router (fast tier)", () => {
    const b = costBreakdown(OMP, { anthropic: { router: billed(0.001), fillers: billed(0.0004) } });
    expect(b.fast).toBeCloseTo(0.0014, 12);
  });

  it("on Claude Code, priced from the Claude table as saved (cache writes included)", () => {
    const fillers = { input_tokens: 346, output_tokens: 85, cache_creation_input_tokens: 809, cache_read_input_tokens: 0 };
    const item = costItems(DEFAULT_CONFIG, { anthropic: { fillers } })[0]!;
    // 346 × $0.10 + 809 × $0.125 (cache write) + 85 × $0.50, per million
    expect(item).toMatchObject({ usd: 0, savedVia: "subscription" });
    expect(item.savedUsd).toBeCloseTo((346 * 0.1 + 809 * 0.125 + 85 * 0.5) / 1e6, 10);
  });
});

describe("itemized and per-call costs", () => {
  it("costItems sum to computeCost and name each part", () => {
    const usage = {
      anthropic: {
        router: billed(0.0003),
        fillers: billed(0.0001),
        solver: { input_tokens: 134, output_tokens: 769, cache_read_input_tokens: 10_214, speed: "standard" },
      },
      elevenChars: 260, elevenSegments: [{ label: "ack", chars: 40 }, { label: "filler", chars: 41 }, { label: "answer", chars: 179 }],
      scribeSeconds: 2.2,
    };
    const items = costItems(OMP, usage);
    expect(items.map((i) => i.label)).toEqual([
      "Router · cerebras/gpt-oss-120b (OhMyPi)", "Progress lines · cerebras/gpt-oss-120b (OhMyPi)",
      "Solver · claude-opus-5-5 (Claude Code · subscription)", "ElevenLabs TTS (eleven_v4_turbo)", "Scribe STT",
    ]);
    expect(items.reduce((n, i) => n + i.usd, 0)).toBeCloseTo(computeCost(OMP, usage), 12);
    expect(items[3]!.detail).toBe("ack 40 · filler 41 · answer 179 chars");
  });

});

describe("Claude Code (subscription)", () => {
  const usage = {
    anthropic: { router: { input_tokens: 300, output_tokens: 170 }, solver: { input_tokens: 134, output_tokens: 769, cache_read_input_tokens: 10_214, speed: "standard" } },
    elevenChars: 100, scribeSeconds: 2,
  };
  it("Claude calls cost $0 in the total and show what they saved; other vendors are still billed", () => {
    const sub = DEFAULT_CONFIG;
    const items = costItems(sub, usage);
    const claude = items.filter((i) => /Claude Code · subscription/.test(i.label));
    expect(claude.map((i) => i.usd)).toEqual([0, 0]);
    expect(claude[1]!.savedUsd).toBeCloseTo(opusCost(usage.anthropic.solver, false), 12);
    expect(computeCost(sub, usage)).toBeCloseTo(100 * 0.04 / 1000 + 2 * 0.39 / 3600, 12);
  });
});

describe("on-device TTS", () => {
  it("is \$0, saved vs ElevenLabs and tagged on-device; Claude Code is tagged subscription", () => {
    const items = costItems({ ...DEFAULT_CONFIG, ttsModel: "macos" }, {
      anthropic: { solver: { input_tokens: 100, output_tokens: 500 } }, localTtsChars: 130, elevenSegments: [{ label: "ack", chars: 40 }, { label: "answer", chars: 90 }],
    });
    const tts = items.find((i) => i.label === "macOS TTS (on-device)")!;
    expect(tts).toMatchObject({ usd: 0, savedVia: "on-device", detail: "ack 40 · answer 90 chars · saved vs ElevenLabs" });
    expect(tts.savedUsd).toBeCloseTo(130 * 0.04 / 1000, 12);
    expect(items.find((i) => i.label.startsWith("Solver"))!.savedVia).toBe("subscription");
  });
});

describe("other harnesses and APIs", () => {
  const cfgWith = (fast: RunConfig["llm"]["fast"], smart: RunConfig["llm"]["smart"]): RunConfig => ({ ...DEFAULT_CONFIG, llm: { fast, smart } });

  it("a call's own price (llmCost) wins: billed for an API, saved for a subscription", () => {
    const config = cfgWith({ provider: "opencode", model: "cerebras/gpt-oss-120b" }, { provider: "codex", model: "gpt-6.1-sol" });
    const usage = {
      anthropic: {
        router: { input_tokens: 1000, output_tokens: 100, llmCost: { usd: 0.002, billing: "api" } },
        solver: { input_tokens: 5000, output_tokens: 900, llmCost: { usd: 0.03, billing: "subscription" } },
      },
    };
    expect(costBreakdown(config, usage)).toMatchObject({ fast: 0.002, smart: 0 });
    const items = costItems(config, usage);
    expect(items[0]).toMatchObject({ label: "Router · cerebras/gpt-oss-120b (opencode)", usd: 0.002 });
    expect(items[1]).toMatchObject({ label: "Solver · gpt-6.1-sol (Codex · subscription)", usd: 0, savedUsd: 0.03, savedVia: "subscription" });
  });

  it("an unknown price is 0 and says so", () => {
    const config = cfgWith({ provider: "pi", model: "" }, DEFAULT_CONFIG.llm.smart);
    const u = { input_tokens: 10, output_tokens: 5, llmCost: { usd: null, billing: "api" } };
    expect(llmCallCost(config, "fast", u)).toEqual({ usd: 0, billing: "api", known: false });
    expect(costItems(config, { anthropic: { router: { ...u, llmCost: { usd: null, billing: "subscription" } } } })[0]!.detail).toMatch(/price unknown/);
  });

  it("Claude Code with another Claude model is priced from the catalog", () => {
    setPriceCatalog({ "anthropic/claude-sonnet-5-5": { input: 3, output: 15 } });
    try {
      const config = cfgWith({ provider: "claude-code", model: "claude-sonnet-5-5" }, DEFAULT_CONFIG.llm.smart);
      expect(llmCallCost(config, "fast", { input_tokens: 1000, output_tokens: 1000 })).toEqual({ usd: 0.018, billing: "subscription", known: true });
      expect(callCost("router", { input_tokens: 1000, output_tokens: 1000 }, "claude-sonnet-5-5")).toBeCloseTo(0.018, 12);
    } finally {
      setPriceCatalog(null);
    }
  });

  it("configs from before tiers, an unknown provider, or a model API on the smart tier get the default (Claude Code)", () => {
    expect(llmOf({})).toEqual(DEFAULT_CONFIG.llm);
    const old = { fast: { provider: "claude-api", model: "x" }, smart: { provider: "codex", model: "gpt-6.1-sol" } } as unknown as RunConfig["llm"];
    expect(llmOf({ llm: old })).toEqual({ fast: DEFAULT_CONFIG.llm.fast, smart: { provider: "codex", model: "gpt-6.1-sol" } });
    const api = { fast: { provider: "openrouter", model: "x" }, smart: { provider: "openrouter", model: "y" } } as RunConfig["llm"];
    expect(llmOf({ llm: api })).toEqual({ fast: { provider: "openrouter", model: "x" }, smart: DEFAULT_CONFIG.llm.smart });
  });
});
