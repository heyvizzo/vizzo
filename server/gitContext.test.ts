import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitContext } from "./gitContext.ts";

const dirs: string[] = [];
const tempDir = (): string => { const d = mkdtempSync(join(tmpdir(), "vizzo-git-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("gitContext", () => {
  it("is empty without a project or outside a git repo", async () => {
    expect(await gitContext(null)).toBe("");
    expect(await gitContext(tempDir())).toBe("");
  });

  it("gives the status, recent commits and uncommitted changes", async () => {
    const d = tempDir();
    const git = (...args: string[]): void => { execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...args]); };
    git("init", "-q");
    writeFileSync(join(d, "demo.css"), "a{}\n");
    git("add", ".");
    git("commit", "-qm", "First styles");
    writeFileSync(join(d, "demo.css"), "a{color:red}\n");
    const block = await gitContext(d);
    expect(block).toMatch(/^Git state of the project/);
    expect(block).toMatch(/git status:\n## .*\n M demo\.css/);
    expect(block).toMatch(/Recent commits:\n\w+ First styles/);
    expect(block).toMatch(/Uncommitted changes[^\n]*\n demo\.css/);
  });
});
