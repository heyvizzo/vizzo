import { describe, expect, it, vi } from "vitest";
import { normalizeSettings, PANEL_KEYS, saveSettingsKeys } from "./settings.ts";

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

describe("source control preferences", () => {
  it("normalizes legacy and invalid settings without opting into Git", () => {
    const defaults = { gitSourceControl: false, commitMessageTier: "fast", autoCommitMessage: true };
    expect(normalizeSettings({})).toMatchObject(defaults);
    expect(normalizeSettings({ gitSourceControl: 1, commitMessageTier: null, autoCommitMessage: null })).toMatchObject(defaults);
  });

  it("saves the Settings panel choices without overwriting the Changes checkbox", () => {
    const settings = normalizeSettings({ gitSourceControl: true, commitMessageTier: "smart", autoCommitMessage: false });
    expect(settings.autoCommitMessage).toBe(false);
    const save = vi.fn();
    saveSettingsKeys({ get: () => null, save }, settings, PANEL_KEYS);
    const saved = JSON.parse(save.mock.calls[0]![0]);
    expect(saved).toMatchObject({ gitSourceControl: true, commitMessageTier: "smart" });
    expect(saved).not.toHaveProperty("autoCommitMessage");
  });
});
