// What git knows about the project, for the solver: a harness without a shell can't run git, and the files under
// .git/ are compressed, so reading them gets it nowhere. The server runs a few read-only git commands itself and
// adds their output to the request. Not a git repo, git missing or too slow: no block.
import { execFile } from "node:child_process";

const TIMEOUT_MS = 2000;
const MAX_LINES = 30;

/** One git command's output in `dir` (trimmed, at most MAX_LINES lines); null if it fails. */
function git(dir: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, "--no-pager", "-c", "color.ui=false", ...args], { timeout: TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve(null);
      const lines = stdout.trimEnd().split("\n");
      resolve(lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more lines`].join("\n") : lines.join("\n"));
    });
  });
}

/** The project's git state as a block for the solver's message ("" when it isn't a git repo). */
export async function gitContext(dir: string | null): Promise<string> {
  if (!dir) return "";
  const [status, log, diff] = await Promise.all([
    git(dir, ["status", "--short", "--branch"]),
    git(dir, ["log", "--oneline", "-10"]),
    git(dir, ["diff", "HEAD", "--stat"]),
  ]);
  if (status === null) return "";
  const parts = [
    `git status:\n${status || "(clean)"}`,
    ...(log ? [`Recent commits:\n${log}`] : []),
    ...(diff ? [`Uncommitted changes (diff --stat against HEAD):\n${diff}`] : []),
  ];
  return `Git state of the project (run by the server just now):\n${parts.join("\n\n")}`;
}
