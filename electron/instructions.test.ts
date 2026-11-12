import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanInstructions, editInstructions, instructionSnapshot, readInstructions } from "./instructions.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "vizzo-instructions-")); dirs.push(dir); return dir; };

describe("saved instructions", () => {
  it("persists both scopes, isolates folders and shares values through symlinks", () => {
    const root = temp();
    const a = join(root, "a"), b = join(root, "b"), alias = join(root, "alias");
    mkdirSync(a); mkdirSync(b); symlinkSync(a, alias);
    let saved = editInstructions(null, { scope: "global", text: "Test, then commit.\nKeep changes focused." });
    saved = editInstructions(saved, { scope: "project", projectDir: alias, text: "Use Tailwind." });
    saved = editInstructions(saved, { scope: "project", projectDir: b, text: "Use CSS modules." });
    const file = join(root, "settings.json");
    writeFileSync(file, JSON.stringify({ instructions: saved, chat: "kept elsewhere" }));
    const reopened = readInstructions(file);
    expect(instructionSnapshot(reopened, a)).toEqual({ global: saved.global, project: "Use Tailwind.", projectDir: realpathSync(a) });
    expect(instructionSnapshot(reopened, b).project).toBe("Use CSS modules.");
    expect(instructionSnapshot(reopened, null)).toEqual({ global: saved.global, project: "", projectDir: null });
    const cleared = editInstructions(reopened, { scope: "project", projectDir: alias, text: "" });
    expect(instructionSnapshot(cleared, a).project).toBe("");
    expect(instructionSnapshot(cleared, b).project).toBe("Use CSS modules.");
    expect(editInstructions(cleared, { scope: "global", text: "" }).global).toBe("");
  });

  it("accepts older settings, ignores malformed stored fields, and rejects invalid writes", () => {
    const file = join(temp(), "settings.json");
    expect(readInstructions(file)).toEqual({ global: "", projects: {} });
    writeFileSync(file, "bad json");
    expect(readInstructions(file)).toEqual({ global: "", projects: {} });
    expect(cleanInstructions({ global: 5, projects: { "/good": "yes", "/bad": 42, relative: "no" } })).toEqual({ global: "", projects: { "/good": "yes" } });
    expect(() => editInstructions(null, { scope: "project", text: "x" })).toThrow("Choose a project");
    expect(() => editInstructions(null, { scope: "global", text: {} })).toThrow("must be text");
  });
});
