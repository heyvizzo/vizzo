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
  it("defaults to Git when settings are missing, legacy, or invalid", () => {
    const defaults = { gitSourceControl: true, commitMessageTier: "fast", autoCommitMessage: true };
    expect(normalizeSettings(null)).toMatchObject(defaults);
    expect(normalizeSettings({ showSolverSession: true })).toMatchObject(defaults);
    expect(normalizeSettings({ gitSourceControl: "false", commitMessageTier: null, autoCommitMessage: null })).toMatchObject(defaults);
  });

  it("saves a Git opt-out, model choice and each tier's timeout independently of automatic drafting", () => {
    const choice = {
      gitSourceControl: false, commitMessageTier: "smart", commitMessageTimeoutSeconds: { fast: 24, smart: 75 },
    };
    const settings = normalizeSettings({ ...choice, autoCommitMessage: false });
    expect(settings.autoCommitMessage).toBe(false);
    const save = vi.fn();
    saveSettingsKeys({ get: () => null, save }, settings, PANEL_KEYS);
    const saved = JSON.parse(save.mock.calls[0]![0]);
    expect(saved).toMatchObject(choice);
    expect(saved).not.toHaveProperty("autoCommitMessage");
  });
});
