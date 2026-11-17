import { isHarness } from "../../shared/config.ts";
import type { HarnessSessionInfo } from "../../shared/harnessSession.ts";
import { EMPTY_CWD } from "./claudeCli.ts";
import { harnessBin, type AgentSpec, type SessionRef } from "./harnesses.ts";
import type { HarnessThread } from "./types.ts";

/** POSIX shell argument, including literal quotes, spaces and command substitutions. */
const quote = (s: string): string => /^[a-zA-Z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`;

export function resumeCommand(spec: AgentSpec, ref: SessionRef, bin = harnessBin(spec.harness)): string {
  const executable = bin ?? (spec.harness === "claude-code" ? "claude" : spec.harness);
  const args = spec.harness === "claude-code" ? ["--resume", ref.id]
    : spec.harness === "codex" ? ["resume", ref.id]
    : spec.harness === "grok" ? ["-r", ref.id]
    : spec.harness === "opencode" ? ["-s", ref.id]
    : ["--session", ref.file ?? ref.id];
  return `cd ${quote(spec.project ?? EMPTY_CWD)} && ${[executable, ...args].map(quote).join(" ")}`;
}

export function harnessSessionInfo(thread: HarnessThread | null): HarnessSessionInfo | null {
  const ref = thread?.session?.();
  // Handles are allocated ahead of their first request (including after a background handoff).
  // A pinned launch spec means startup has actually begun.
  if (!thread?.spec && !ref) return null;
  const provider = thread?.spec?.harness ?? thread?.choice?.provider;
  if (!provider || !isHarness(provider)) return null;
  return {
    provider,
    ...(ref ? { id: ref.id } : {}),
    ...(ref && thread?.spec ? { resumeCommand: resumeCommand(thread.spec, ref) } : {}),
  };
}
