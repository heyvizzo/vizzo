import { describe, expect, it } from "vitest";
import { normalizeSettings } from "./settings.ts";

describe("showSolverSession", () => {
  it("is off by default", () => {
    expect(normalizeSettings({}).showSolverSession).toBe(false);
  });
  it("follows Debugging details when saved before it had its own switch", () => {
    expect(normalizeSettings({ showDebug: true }).showSolverSession).toBe(true);
  });
  it("is independent of Debugging details once saved", () => {
    expect(normalizeSettings({ showDebug: true, showSolverSession: false }).showSolverSession).toBe(false);
    expect(normalizeSettings({ showDebug: false, showSolverSession: true }).showSolverSession).toBe(true);
  });
});
