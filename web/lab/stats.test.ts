import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type RunConfig } from "../../shared/config.ts";
import { deriveMetrics, type MarkName } from "../../shared/marks.ts";
import type { RunRecord } from "../../shared/protocol.ts";
import { flattenRun, groupRuns, mean, mergeRun, percentile, summarize, summaryTable, toCsv, variantKey } from "./stats.ts";

function run(over: Partial<RunConfig>, marks: Partial<Record<MarkName, number>>, extra: Partial<RunRecord> = {}): RunRecord {
  const config = { ...DEFAULT_CONFIG, ...over };
  return {
    runId: Math.random().toString(36).slice(2), turnId: "t", approach: config.approach, config, marks, metrics: deriveMetrics(marks),
    transcript: "", pointing: [], voiceText: "", opusText: "", usage: {}, costUsd: 0.01, clock: { rttMs: 1, offsetMs: 2 }, ...extra,
  };
}

describe("percentile", () => {
  it("interpolates linearly between closest ranks (numpy default)", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 90)).toBeCloseTo(3.7);
    expect(percentile([10, 20, 30, 40, 50], 90)).toBeCloseTo(46);
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([4, 1, 3, 2], 0)).toBe(1);
    expect(percentile([4, 1, 3, 2], 100)).toBe(4);
  });
  it("ignores non-finite values and returns null when empty", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([NaN, 3, Infinity, 1], 50)).toBe(2);
  });
  it("does not mutate the input", () => {
    const xs = [3, 1, 2];
    percentile(xs, 50);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe("mean / summarize", () => {
  it("mean", () => {
    expect(mean([1, 2, 3, 6])).toBe(3);
    expect(mean([])).toBeNull();
  });
  it("summarize skips nulls and counts n", () => {
    expect(summarize([100, null, 300, undefined, 200])).toEqual({ n: 3, p50: 200, p90: 280, mean: 200 });
    expect(summarize([null])).toEqual({ n: 0, p50: null, p90: null, mean: null });
  });
});

describe("variantKey / grouping", () => {
  it("only includes fields relevant to the approach", () => {
    expect(variantKey({ ...DEFAULT_CONFIG, approach: "realtime", routerMode: "auto" })).toBe("realtime · rt-2.1 · opus:std");
    expect(variantKey({ ...DEFAULT_CONFIG, approach: "realtime", realtimeModel: "gpt-realtime-2.1-mini", opusFast: true }))
      .toBe("realtime · rt-2.1-mini · opus:fast");
    expect(variantKey({ ...DEFAULT_CONFIG, approach: "pipeline", routerMode: "auto" })).toBe("pipeline · router:auto · v4_turbo · opus:std");
    expect(variantKey({ ...DEFAULT_CONFIG, approach: "hybrid", hybridWaitMs: 0, prewarm: false })).toBe("hybrid · rt-2.1 · wait:0 · opus:std · cold");
  });
  it("orders groups A, B, C", () => {
    const rs = [run({ approach: "hybrid" }, {}), run({ approach: "pipeline" }, {}), run({ approach: "realtime" }, {}), run({ approach: "pipeline" }, {})];
    const g = groupRuns(rs, "approach");
    expect([...g.keys()]).toEqual(["realtime", "pipeline", "hybrid"]);
    expect(g.get("pipeline")).toHaveLength(2);
  });
});

describe("summaryTable", () => {
  const rs = [
    run({ approach: "pipeline" }, { release: 1000, "ack.played": 1400, "answer.played": 3000 }, { fixtureId: "U01" }),
    run({ approach: "pipeline" }, { release: 1000, "ack.played": 1600 }, { fixtureId: "U01", costUsd: 0.03 }),
    run({ approach: "realtime" }, { release: 0, "ack.played": 500 }, { fixtureId: "U02" }),
  ];
  it("computes p50/p90/mean per group × metric", () => {
    const t = summaryTable(rs, "approach");
    const pipe = t.find((g) => g.key === "pipeline")!;
    expect(pipe.n).toBe(2);
    expect(pipe.stats.ttfa).toEqual({ n: 2, p50: 500, p90: 580, mean: 500 });
    expect(pipe.stats.tta.n).toBe(1);
    expect(pipe.stats.costUsd.mean).toBeCloseTo(0.02);
  });
  it("filters by fixture", () => {
    expect(summaryTable(rs, "approach", "U02").map((g) => g.key)).toEqual(["realtime"]);
    expect(summaryTable(rs, "approach", "nope")).toEqual([]);
  });
});

describe("mergeRun", () => {
  it("overlays client marks and recomputes metrics", () => {
    const server = run({}, { release: 100, "stt.final": 300, "ack.played": 900 });
    server.metrics = { ...server.metrics, ttfa: 12345 };
    const m = mergeRun(server, { press: 0, release: 100, "ack.played": 700, "answer.played": undefined });
    expect(m.marks["ack.played"]).toBe(700);
    expect(m.marks["stt.final"]).toBe(300);
    expect(m.metrics.ttfa).toBe(600);
    expect(m.metrics.stt).toBe(200);
  });
});

describe("export", () => {
  it("flattens config, metrics and marks relative to release", () => {
    const r = run({ approach: "realtime" }, { press: 0, release: 1000, "ack.played": 1350 }, { fixtureId: "U03" });
    const row = flattenRun(r);
    expect(row["config.approach"]).toBe("realtime");
    expect(row.ttfa).toBe(350);
    expect(row["mark.press"]).toBe(-1000);
    expect(row["mark.opus.done"]).toBeNull();
    expect(row.fixtureId).toBe("U03");
  });
  it("writes RFC 4180 CSV with escaping", () => {
    const r = run({}, { release: 0 }, { transcript: 'say "hi", then\nbye', costUsd: 0.0123456 });
    const csv = toCsv([r]);
    const [header, line] = csv.split("\r\n");
    expect(header!.split(",")).toContain("mark.answer.played");
    expect(csv).toContain('"say ""hi"", then\nbye"');
    expect(line).toContain("0.012");
    expect(toCsv([])).toBe("");
  });
});
