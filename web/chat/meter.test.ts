import { describe, expect, it } from "vitest";
import {
  DEFAULT_THRESHOLD_DB, THRESHOLD_MAX_DB, THRESHOLD_MIN_DB, clampThreshold, dbToPos, dbToRms, formatDb, rmsToDb, yToThreshold,
} from "./meter.ts";

describe("meter scale", () => {
  it("round-trips dB and clamps the line inside the grabbable range", () => {
    expect(rmsToDb(dbToRms(-32))).toBeCloseTo(-32, 6);
    expect(rmsToDb(clampThreshold(dbToRms(DEFAULT_THRESHOLD_DB)))).toBeCloseTo(DEFAULT_THRESHOLD_DB, 5);
    expect(rmsToDb(clampThreshold(dbToRms(-80)))).toBeCloseTo(THRESHOLD_MIN_DB, 5);
    expect(rmsToDb(clampThreshold(dbToRms(-1)))).toBeCloseTo(THRESHOLD_MAX_DB, 5);
    expect(clampThreshold(Number.NaN)).toBeCloseTo(dbToRms(DEFAULT_THRESHOLD_DB), 8);
    expect(clampThreshold(0)).toBeCloseTo(dbToRms(DEFAULT_THRESHOLD_DB), 8);
  });

  it("maps the bottom of the scale to silence and the middle to −30 dB", () => {
    expect(dbToPos(-60)).toBe(0);
    expect(dbToPos(0)).toBe(1);
    expect(dbToPos(-30)).toBeCloseTo(0.5, 6);
  });

  it("dragging down the graph lowers the threshold", () => {
    const top = 10;
    const h = 72;
    const high = yToThreshold(top + 8, top, h);
    const low = yToThreshold(top + 60, top, h);
    expect(high).toBeGreaterThan(low);
    expect(rmsToDb(yToThreshold(top, top, h))).toBeCloseTo(THRESHOLD_MAX_DB, 5);
    expect(rmsToDb(yToThreshold(top + h, top, h))).toBeCloseTo(THRESHOLD_MIN_DB, 5);
  });

  it("puts the line back where a dB value is drawn", () => {
    const top = 10;
    const h = 72;
    const pos = dbToPos(-32);
    const y = top + (1 - pos) * h;
    expect(rmsToDb(yToThreshold(y, top, h))).toBeCloseTo(-32, 5);
  });

  it("formats a negative level with a minus sign", () => {
    expect(formatDb(dbToRms(-12))).toBe("\u221212 dB");
    expect(formatDb(1)).toBe("0 dB");
  });
});
