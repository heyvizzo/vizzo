// An app opened from Finder or the Dock gets launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), not the one the user's
// shell builds, so the harness CLIs (claude, codex…), the node they run on, uv and Homebrew aren't found. The packaged
// app asks the login shell for its PATH once at launch and puts it in front (electron/main.ts).
import { execFileSync } from "node:child_process";

/** `shellPath`'s folders first, then any of `current`'s it lacks, each once. */
export function mergePath(shellPath: string, current: string): string {
  const seen = new Set<string>();
  return [...shellPath.split(":"), ...current.split(":")].filter((d) => d && !seen.has(d) && seen.add(d)).join(":");
}

/** The PATH of the user's login shell, or "" if it can't be read in time. */
export function loginShellPath(shell = process.env.SHELL || "/bin/zsh"): string {
  try {
    // -i -l: the files that set PATH (.zprofile, .zshrc…). The markers skip whatever those files print.
    const out = execFileSync(shell, ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    return /__PATH__(.*)__PATH__/s.exec(out)?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}
