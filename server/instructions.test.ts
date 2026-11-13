import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESSES } from "../shared/config.ts";
import { roleSystem, harnessPromptInfo } from "./adapters/claude.ts";
import { setProjectDir } from "./project.ts";
import { solverInstructions } from "./instructions.ts";

let root: string, file: string, project: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vizzo-prompt-instructions-"));
  file = join(root, "settings.json");
  project = join(root, "project");
  mkdirSync(project);
  setProjectDir(project);
  vi.stubEnv("VIZZO_SETTINGS_FILE", file);
});
afterEach(() => { setProjectDir(null); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const save = (global: string, local: string) => writeFileSync(file, JSON.stringify({ instructions: { global, projects: { [realpathSync(project)]: local, "/other": "unrelated project rule" } } }));

describe("solver instruction composition", () => {
  it("combines labeled scopes on every harness, preserves format, and exposes them in the inspector", () => {
    save("Always run tests and commit.", "Use Tailwind classnames.");
    for (const provider of HARNESSES) {
      const prompt = roleSystem("solver", provider);
      expect(prompt.system).toContain("SPOKEN:");
      expect(prompt.system).toContain("## All projects\n\nAlways run tests and commit.");
      expect(prompt.system).toContain("## This project\n\nUse Tailwind classnames.");
      expect(prompt.system).toContain("standing authorization");
      expect(prompt.system).not.toContain("unrelated project rule");
      const info = harnessPromptInfo("solver", { provider, model: "" }, { messages: [{ role: "user", content: "change it" }] });
      // The inspector shows the prompt as its layers: the prompt file, the project note, each saved scope.
      expect(info.system?.map(s => s.text).join("\n\n")).toBe(prompt.system);
      expect(info.system?.map(s => s.label)).toEqual([
        "solver.md", "project note (what this harness's switches give it)",
        "saved instructions · Saved instruction rules", "saved instructions · All projects", "saved instructions · This project",
      ]);
      expect(info.settings?.composition).toMatch(/appended to .*own system prompt/);
    }
    expect(roleSystem("solver", "claude-code", { shell: false }).system).toContain("You have no shell");
    expect(roleSystem("router", "claude-code").system).not.toContain("Always run tests and commit.");
    expect(roleSystem("fillers", "claude-code").system).not.toContain("Use Tailwind classnames.");
  });

  it("picks up edits and clears without restarting, and never leaks another folder's instructions", () => {
    expect(solverInstructions()).toEqual([]);
    save("global", "first");
    expect(solverInstructions().at(-1)?.text).toBe("first");
    save("global", "updated");
    expect(solverInstructions().at(-1)?.text).toBe("updated");
    setProjectDir(root);
    expect(solverInstructions().map(s => s.text)).toContain("global");
    expect(solverInstructions().map(s => s.text)).not.toContain("updated");
    setProjectDir(null);
    expect(roleSystem("solver", "claude-code").system).toContain("You have no tools");
    expect(solverInstructions().at(-1)?.label).toBe("All projects");
    save("", "");
    expect(solverInstructions()).toEqual([]);
  });
});
