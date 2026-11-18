import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface HunkRange {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** Git's byte-oriented line diff. This runs inside the ledger worker in production. */
export function lineDiff(before: Buffer, after: Buffer): HunkRange[] {
  if (before.equals(after)) return [];
  if (!before.length || !after.length) {
    return [{ oldStart: 0, oldCount: lineCount(before), newStart: 0, newCount: lineCount(after) }];
  }
  const directory = mkdtempSync(join(tmpdir(), "vizzo-diff-"));
  try {
    writeFileSync(join(directory, "before"), before, { mode: 0o600 });
    writeFileSync(join(directory, "after"), after, { mode: 0o600 });
    // Run outside the user's repo and ignore global/system diff settings. Only the ranges are needed.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    env.GIT_CONFIG_GLOBAL = "/dev/null";
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CEILING_DIRECTORIES = directory;
    const result = spawnSync("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--no-indent-heuristic",
      "--text", "--unified=0", "--", "before", "after"], {
      cwd: directory, env, maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 1) throw new Error("Could not diff source-control versions");
    const ranges: HunkRange[] = [];
    const pattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
    for (const line of result.stdout.toString("latin1").split("\n")) {
      const match = pattern.exec(line);
      if (!match) continue;
      const oldCount = Number(match[2] ?? 1);
      const newCount = Number(match[4] ?? 1);
      ranges.push({
        oldStart: Number(match[1]) - Number(oldCount !== 0), oldCount,
        newStart: Number(match[3]) - Number(newCount !== 0), newCount,
      });
    }
    if (!ranges.length) throw new Error("Git did not return source-control diff ranges");
    return ranges;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function lineCount(content: Buffer): number {
  let count = Number(content.length > 0 && content[content.length - 1] !== 10);
  for (const byte of content) if (byte === 10) count++;
  return count;
}
