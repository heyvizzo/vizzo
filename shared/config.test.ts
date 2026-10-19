import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, taskTimeoutMs } from "./config.ts";

describe("taskTimeoutMs", () => {
  it("is the config's limit in ms", () => {
    expect(taskTimeoutMs({ taskTimeoutMinutes: 45 })).toBe(45 * 60_000);
  });
  it("falls back to the default for a config without a valid limit (older clients, bad values)", () => {
    const fallback = DEFAULT_CONFIG.taskTimeoutMinutes * 60_000;
    expect(taskTimeoutMs({})).toBe(fallback);
    expect(taskTimeoutMs({ taskTimeoutMinutes: 0 })).toBe(fallback);
    expect(taskTimeoutMs({ taskTimeoutMinutes: 2.5 })).toBe(fallback);
    expect(taskTimeoutMs({ taskTimeoutMinutes: 10_000 })).toBe(fallback);
  });
});
