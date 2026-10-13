import { describe, expect, it } from "vitest";
import { capturePerfTime, outputPerfTime, renderPerfTime, type ClockSnapshot } from "./timing.ts";

const snap = (over: Partial<ClockSnapshot> = {}): ClockSnapshot => ({
  ts: { contextTime: 10, performanceTime: 5000 },
  currentTime: 10.02,
  now: 5005,
  baseLatency: 0.005,
  outputLatency: 0.015,
  ...over,
});

describe("timing", () => {
  it("outputPerfTime extrapolates from getOutputTimestamp", () => {
    expect(outputPerfTime(10, snap())).toBe(5000);
    expect(outputPerfTime(10.5, snap())).toBeCloseTo(5500, 6);
    expect(outputPerfTime(9.9, snap())).toBeCloseTo(4900, 6);
  });

  it("renderPerfTime subtracts base + output latency", () => {
    expect(renderPerfTime(10, snap())).toBeCloseTo(5000 - 20, 6);
  });

  it("capturePerfTime subtracts input latency and clamps to notAfter", () => {
    expect(capturePerfTime(10, snap(), 0.01)).toBeCloseTo(5000 - 20 - 10, 6);
    expect(capturePerfTime(11, snap(), 0, 5100)).toBe(5100);
  });

  it("falls back to currentTime/now when getOutputTimestamp is not ready (zeros)", () => {
    const s = snap({ ts: { contextTime: 0, performanceTime: 0 } });
    expect(renderPerfTime(10.02, s)).toBeCloseTo(5005, 6);
    expect(renderPerfTime(10, s)).toBeCloseTo(4985, 6);
    expect(outputPerfTime(10.02, s)).toBeCloseTo(5005 + 20, 6);
  });

  it("output and render mappings are consistent between the two paths", () => {
    // A context whose output timestamp agrees with the fallback model should give the same answers.
    const s = snap({ ts: { contextTime: 10.02, performanceTime: 5005 + 20 } });
    const f = snap({ ts: {} });
    for (const t of [9.5, 10, 10.02, 11]) {
      expect(outputPerfTime(t, s)).toBeCloseTo(outputPerfTime(t, f), 6);
      expect(renderPerfTime(t, s)).toBeCloseTo(renderPerfTime(t, f), 6);
    }
  });
});
