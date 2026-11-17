import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessId } from "../../shared/config.ts";
import type { AgentSpec } from "./harnesses.ts";
import type { HarnessThread } from "./types.ts";
import { harnessSessionInfo, resumeCommand } from "./sessionInfo.ts";

const spec = (harness: HarnessId): AgentSpec => ({ role: "solver", harness, model: "m", system: "", project: "/project" });

describe("terminal resume commands", () => {
  it.each([
    ["claude-code", "claude --resume native-id"], ["codex", "codex resume native-id"],
    ["grok", "grok -r native-id"], ["opencode", "opencode -s native-id"],
    ["pi", "pi --session /saved/session.jsonl"], ["omp", "omp --session /saved/session.jsonl"],
  ] as const)("uses %s's native interactive command", (harness, command) => {
    expect(resumeCommand(spec(harness), { id: "native-id", file: "/saved/session.jsonl" }, null)).toBe(`cd /project && ${command}`);
  });

  it("preserves every argument and working directory through an actual shell", () => {
    const dir = mkdtempSync(join(tmpdir(), "vizzo-resume-"));
    try {
      const project = join(dir, "Project's $(whoami) `whoami` folder");
      mkdirSync(project);
      const bin = join(dir, "agent's $(whoami) cli");
      writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\n');
      chmodSync(bin, 0o755);
      const id = "session'; $(whoami) `whoami` \"id\"";
      const command = resumeCommand({ ...spec("codex"), project }, { id }, bin);
      expect(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }).trimEnd().split("\n")).toEqual([project, "resume", id]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("uses the saved native id and pinned provider and directory, never Vizzo's handle id", () => {
    const thread = {
      id: "hthread-1", choice: { provider: "codex", model: "changed" }, spec: spec("claude-code"),
      session: () => ({ id: "native-id" }),
    } as HarnessThread;
    expect(harnessSessionInfo(thread)).toMatchObject({ provider: "claude-code", id: "native-id" });
    expect(harnessSessionInfo(thread)?.resumeCommand).toMatch(/^cd \/project && .* --resume native-id$/);
    expect(harnessSessionInfo(thread)?.resumeCommand).not.toContain("hthread-1");
  });

  it("shows a starting provider without inventing an id or resume command", () => {
    const thread = { id: "hthread-1", spec: spec("codex"), choice: { provider: "codex", model: "m" }, session: () => undefined } as unknown as HarnessThread;
    expect(harnessSessionInfo(thread)).toEqual({ provider: "codex" });
    expect(harnessSessionInfo(null)).toBeNull();
  });

  it("hides a reserved continuation before its first request begins", () => {
    const thread = { choice: { provider: "codex", model: "m" }, session: () => undefined } as unknown as HarnessThread;
    expect(harnessSessionInfo(thread)).toBeNull();
  });
});
