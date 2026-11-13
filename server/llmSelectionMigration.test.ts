import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentSelection, dismissSelectionNotice, migrateSelection, resetSelectionCache, selectionNotice, setSelection } from "./llmSelection.ts";

let dir: string, file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vizzo-selection-"));
  file = join(dir, "llm-selection.json");
  vi.stubEnv("LLM_SELECTION_FILE", file);
  vi.stubEnv("WARM_AGENTS", "0");
  resetSelectionCache();
});
afterEach(() => { vi.unstubAllEnvs(); resetSelectionCache(); rmSync(dir, { recursive: true, force: true }); });

const OLD = {
  fast: { provider: "claude-code", model: "claude-haiku-5-5", level: "low", toggles: { shell: true } },
  smart: { provider: "codex", model: "gpt-6.1-sol", level: "high", toggles: { shell: false, web: true } },
};

describe("the saved selection's one-time move to the new switch defaults", () => {
  it("clears the smart tier's switches (all on now), keeps model and level and the fast tier as they were", () => {
    writeFileSync(file, JSON.stringify(OLD));
    const sel = currentSelection();
    expect(sel.smart).toEqual({ provider: "codex", model: "gpt-6.1-sol", level: "high" });
    expect(sel.fast).toEqual(OLD.fast);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.version).toBe(2);
    // Codex's shell was switched off, web on; the rest were off by default.
    expect(saved.notice).toEqual({ harness: "Codex", turnedOn: ["Shell", "Subagents", "Image generation", "MCP servers", "Skills", "Hooks", "Plugins", "AGENTS.md"] });
  });

  it("happens once: a later choice to switch one off is kept across restarts", () => {
    writeFileSync(file, JSON.stringify(OLD));
    currentSelection();
    setSelection({ fast: OLD.fast as never, smart: { provider: "codex", model: "gpt-6.1-sol", toggles: { mcp: false } } });
    resetSelectionCache();
    expect(currentSelection().smart.toggles).toEqual({ mcp: false });
  });

  it("the notice stays until it is dismissed, and survives a new selection", () => {
    writeFileSync(file, JSON.stringify(OLD));
    expect(selectionNotice()?.harness).toBe("Codex");
    setSelection(currentSelection());
    resetSelectionCache();
    expect(selectionNotice()?.harness).toBe("Codex");
    dismissSelectionNotice();
    resetSelectionCache();
    expect(selectionNotice()).toBeNull();
  });

  it("nothing to say when nothing turned on; a first run has no notice", () => {
    expect(migrateSelection({ fast: OLD.fast as never, smart: { provider: "pi", model: "", toggles: { shell: true, skills: true, plugins: true, instructions: true } } }).notice).toBeNull();
    expect(selectionNotice()).toBeNull();
  });
});
