import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmChoice } from "../../shared/config.ts";
import { MAX_LIVE_THREAD_SESSIONS } from "../../shared/threads.ts";
import { claudeEditedFiles, codexEditedFiles, opencodeEditedFiles, patchFiles, projectRelative, rpcEditedFiles, type AgentSpec, type HarnessResult, type WarmAgent } from "./harnesses.ts";
import { liveHarnessSessions, openHarnessThread, withReplay } from "./harnessThread.ts";
import { configureWarm, registerRoleSpecs, setAgentFactory, setWarmLogger, stopWarm } from "./warmPool.ts";

const SMART: LlmChoice = { provider: "claude-code", model: "claude-opus-5-5", level: "high" };
const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fake agent: each request waits until the test answers it (or aborts it). */
class Fake implements WarmAgent {
  dead = false;
  keptAgent: boolean;
  messages: string[] = [];
  pending: { resolve: (r: HarnessResult) => void; reject: (e: Error) => void }[] = [];
  aborts = 0;
  constructor(readonly spec: AgentSpec, keep = false, private hasAbort = true) { this.keptAgent = keep; made.push(this); }
  alive() { return !this.dead; }
  ready() { return true; }
  keep() { this.keptAgent = true; return true; }
  request(user: string, onText: ((d: string) => void) | undefined): Promise<HarnessResult> {
    this.messages.push(user);
    onText?.("…");
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  answer(text: string, filesTouched?: string[]) {
    this.pending.shift()!.resolve({ text, stopReason: "end_turn", model: "m", usage: {}, raw: null, warm: true, ...(filesTouched ? { filesTouched } : {}) });
  }
  get abort() {
    if (!this.hasAbort) return undefined;
    return () => { this.aborts++; this.pending.shift()?.reject(new Error("turn interrupted")); };
  }
  kill() { this.dead = true; for (const p of this.pending.splice(0)) p.reject(new Error("killed")); }
}
let made: Fake[] = [];
let withAbort = true;

setWarmLogger(() => {});
beforeEach(() => {
  made = [];
  withAbort = true;
  registerRoleSpecs((role) => ({ system: `${role.toUpperCase()} system`, project: "/proj" }));
  setAgentFactory((s, keep) => new Fake(s, keep, withAbort));
});
afterEach(() => { stopWarm(); setAgentFactory(null); vi.unstubAllEnvs(); });

const sessionsLeft: { close(): void }[] = [];
afterEach(() => { for (const t of sessionsLeft.splice(0)) t.close(); });
const open = (replay = () => "") => { const t = openHarnessThread({ role: "solver", choice: SMART, replay }); sessionsLeft.push(t); return t; };

describe("harness threads", () => {
  it("keeps one solver agent across requests; replay only when a session is opened", async () => {
    let history = "";
    const t = open(() => history);
    expect(t.live).toBe(false);
    const first = t.send("make it red", undefined, 1000);
    await until(() => made.length === 1 && made[0]!.pending.length === 1);
    expect(made[0]!.spec).toMatchObject({ role: "solver", model: "claude-opus-5-5", level: "high", project: "/proj", system: "SOLVER system" });
    expect(made[0]!.keptAgent).toBe(true);
    expect(made[0]!.messages).toEqual(["make it red"]); // empty replay: nothing prepended
    made[0]!.answer("done", ["a.css"]);
    expect(await first).toMatchObject({ text: "done", reopened: false, filesTouched: ["a.css"] });
    history = "user: make it red\nassistant: done";
    const second = await (async () => { const p = t.send("and bigger", undefined, 1000); await until(() => made[0]!.pending.length === 1); made[0]!.answer("ok"); return p; })();
    expect(second).toMatchObject({ text: "ok", reopened: false, filesTouched: [] });
    expect(made).toHaveLength(1);
    expect(made[0]!.messages[1]).toBe("and bigger");
    expect(t.live).toBe(true);
  });

  it("takes a warm pooled agent (it never goes back to the pool)", async () => {
    configureWarm({ fast: SMART, smart: SMART });
    const pooled = made.filter((a) => a.spec.role === "solver");
    expect(pooled).toHaveLength(1);
    const t = open();
    const p = t.send("hi", undefined, 1000);
    await until(() => pooled[0]!.pending.length === 1);
    expect(pooled[0]!.keptAgent).toBe(true);
    await until(() => made.filter((a) => a.spec.role === "solver").length === 2); // the pool's replacement
    pooled[0]!.answer("x");
    await p;
  });

  it("serializes requests: a second send waits for the first", async () => {
    const t = open();
    const order: string[] = [];
    const a = t.send("one", undefined, 1000).then((r) => order.push(r.text));
    const b = t.send("two", undefined, 1000).then((r) => order.push(r.text));
    await until(() => made[0]?.pending.length === 1);
    await tick(); await tick();
    expect(made[0]!.messages).toEqual(["one"]);
    made[0]!.answer("1");
    await until(() => made[0]!.messages.length === 2);
    made[0]!.answer("2");
    await Promise.all([a, b]);
    expect(order).toEqual(["1", "2"]);
  });

  it("abort rejects with AbortError and the session stays (harness interrupt)", async () => {
    const t = open(() => "HISTORY");
    const p = t.send("slow", undefined, 1000);
    await until(() => made[0]?.pending.length === 1);
    expect(made[0]!.messages[0]).toBe(withReplay("HISTORY", "slow"));
    t.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(made[0]!.aborts).toBe(1);
    const q = t.send("again", undefined, 1000);
    await until(() => made[0]!.pending.length === 1);
    made[0]!.answer("ok");
    expect(await q).toMatchObject({ text: "ok", reopened: false });
    expect(made).toHaveLength(1);
  });

  it("abort without an interrupt kills the session: the next send reopens with the replay", async () => {
    withAbort = false;
    const t = open(() => "HISTORY");
    const p = t.send("slow", undefined, 1000);
    await until(() => made[0]?.pending.length === 1);
    t.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(made[0]!.dead).toBe(true);
    expect(t.live).toBe(false);
    const q = t.send("again", undefined, 1000);
    await until(() => made[1]?.pending.length === 1);
    expect(made[1]!.messages[0]).toBe(withReplay("HISTORY", "again"));
    made[1]!.answer("ok");
    expect(await q).toMatchObject({ reopened: true });
  });

  it("a crashed session reopens with the replay; errors reach the caller", async () => {
    const t = open(() => "H");
    const p = t.send("x", undefined, 1000);
    await until(() => made[0]?.pending.length === 1);
    made[0]!.kill();
    await expect(p).rejects.toThrow("killed");
    const q = t.send("y", undefined, 1000);
    await until(() => made[1]?.pending.length === 1);
    made[1]!.answer("ok");
    expect(await q).toMatchObject({ reopened: true });
  });

  it(`keeps at most ${MAX_LIVE_THREAD_SESSIONS} live sessions: the least recently used idle one is closed`, async () => {
    const threads = Array.from({ length: MAX_LIVE_THREAD_SESSIONS + 1 }, (_, i) => open(() => `H${i}`));
    for (let i = 0; i < MAX_LIVE_THREAD_SESSIONS; i++) {
      const p = threads[i]!.send(`m${i}`, undefined, 1000);
      await until(() => made[i]?.pending.length === 1);
      made[i]!.answer("ok");
      await p;
    }
    expect(liveHarnessSessions()).toBe(MAX_LIVE_THREAD_SESSIONS);
    // Thread 0 used again: thread 1 is now the least recently used.
    const again = threads[0]!.send("again", undefined, 1000);
    await until(() => made[0]!.pending.length === 1);
    made[0]!.answer("ok");
    await again;
    const p = threads[MAX_LIVE_THREAD_SESSIONS]!.send("new", undefined, 1000);
    await until(() => made[MAX_LIVE_THREAD_SESSIONS]?.pending.length === 1);
    expect(made[1]!.dead).toBe(true);
    expect(threads[1]!.live).toBe(false);
    expect(made.filter((a) => a.dead)).toHaveLength(1);
    made[MAX_LIVE_THREAD_SESSIONS]!.answer("ok");
    await p;
    expect(liveHarnessSessions()).toBe(MAX_LIVE_THREAD_SESSIONS);
    // The evicted thread reopens with its replay.
    const back = threads[1]!.send("back", undefined, 1000);
    await until(() => made.length === MAX_LIVE_THREAD_SESSIONS + 2 && made.at(-1)!.pending.length === 1);
    expect(made.at(-1)!.messages[0]).toBe(withReplay("H1", "back"));
    made.at(-1)!.answer("ok");
    expect(await back).toMatchObject({ reopened: true });
  });

  it("when every session is busy the cap is exceeded, then the oldest idle one is closed", async () => {
    const threads = Array.from({ length: MAX_LIVE_THREAD_SESSIONS + 1 }, () => open());
    const runs = threads.map((t, i) => t.send(`m${i}`, undefined, 1000));
    await until(() => made.length === MAX_LIVE_THREAD_SESSIONS + 1 && made.every((a) => a.pending.length === 1));
    expect(made.filter((a) => a.dead)).toHaveLength(0);
    expect(liveHarnessSessions()).toBe(MAX_LIVE_THREAD_SESSIONS + 1);
    made[3]!.answer("ok");
    await runs[3];
    await until(() => made[3]!.dead);
    expect(liveHarnessSessions()).toBe(MAX_LIVE_THREAD_SESSIONS);
    for (const [i, a] of made.entries()) if (i !== 3) a.answer("ok");
    await Promise.all(runs);
  });

  it("close ends the session for good", async () => {
    const t = open();
    const p = t.send("x", undefined, 1000);
    await until(() => made[0]?.pending.length === 1);
    t.close();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(made[0]!.dead).toBe(true);
    expect(t.live).toBe(false);
    await expect(t.send("y", undefined, 1000)).rejects.toThrow("closed");
  });

  it("stopWarm (server exit) kills thread agents", async () => {
    const t = open();
    const p = t.send("x", undefined, 1000);
    await until(() => made[0]?.pending.length === 1);
    made[0]!.answer("ok");
    await p;
    stopWarm();
    expect(made[0]!.dead).toBe(true);
    expect(t.live).toBe(false);
  });
});

describe("claude-code thread (fake stream-json CLI)", () => {
  it("keeps the process across requests and reports the files it edited", async () => {
    setAgentFactory(null);
    const project = mkdtempSync(join(tmpdir(), "rv-thread-"));
    registerRoleSpecs(() => ({ system: "SOLVER", project }));
    vi.stubEnv("CLAUDE_BIN", fileURLToPath(new URL("./__fixtures__/fake-claude-session.mjs", import.meta.url)));
    const t = open();
    const a = await t.send(`edit ${join(project, "src/a.ts")}`, undefined, 5000);
    expect(a).toMatchObject({ text: `turn 1: edit ${join(project, "src/a.ts")}`, filesTouched: ["src/a.ts"], reopened: false });
    const b = await t.send("and again", undefined, 5000);
    expect(b.text).toBe("turn 2: and again"); // same process: its context carried over
    expect(b.filesTouched).toEqual([]);
    expect(t.live).toBe(true);
  });
});

describe("files touched from harness events", () => {
  it("Claude Code: Edit / Write / MultiEdit / NotebookEdit tool_use blocks", () => {
    const ev = {
      type: "assistant", message: { content: [
        { type: "text", text: "editing" },
        { type: "tool_use", name: "Edit", input: { file_path: "/proj/a.css" } },
        { type: "tool_use", name: "Read", input: { file_path: "/proj/b.css" } },
        { type: "tool_use", name: "Write", input: { file_path: "/proj/c.html" } },
        { type: "tool_use", name: "MultiEdit", input: { file_path: "/proj/d.ts" } },
        { type: "tool_use", name: "NotebookEdit", input: { notebook_path: "/proj/e.ipynb" } },
      ] },
    };
    expect(claudeEditedFiles(ev)).toEqual(["/proj/a.css", "/proj/c.html", "/proj/d.ts", "/proj/e.ipynb"]);
    expect(claudeEditedFiles({ type: "stream_event", event: {} })).toEqual([]);
    expect(claudeEditedFiles({ type: "assistant", message: {} })).toEqual([]);
  });

  it("paths are made project-relative; outside paths stay absolute", () => {
    expect(projectRelative("/proj", "/proj/src/a.ts")).toBe("src/a.ts");
    expect(projectRelative("/proj", "./src/../b.ts")).toBe("b.ts");
    expect(projectRelative("/proj", "/other/c.ts")).toBe("/other/c.ts");
    expect(projectRelative(undefined, "/x/y")).toBe("/x/y");
  });

  it("Codex file changes, opencode tool parts, pi/omp tool events, apply_patch text", () => {
    expect(codexEditedFiles({ type: "fileChange", changes: [{ path: "/p/a.ts", kind: "update", diff: "" }, { path: "/p/b.ts" }] })).toEqual(["/p/a.ts", "/p/b.ts"]);
    expect(codexEditedFiles({ type: "agentMessage" })).toEqual([]);
    expect(opencodeEditedFiles({ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "/p/a.ts" } } })).toEqual(["/p/a.ts"]);
    expect(opencodeEditedFiles({ type: "tool", tool: "edit", state: { status: "running", input: { filePath: "/p/a.ts" } } })).toEqual([]);
    expect(opencodeEditedFiles({ type: "tool", tool: "read", state: { status: "completed", input: { filePath: "/p/a.ts" } } })).toEqual([]);
    expect(opencodeEditedFiles({ type: "tool", tool: "apply_patch", state: { status: "completed", input: { patchText: "*** Begin Patch\n*** Update File: src/x.ts\n@@\n*** Add File: y.ts\n*** End Patch" } } })).toEqual(["src/x.ts", "y.ts"]);
    expect(rpcEditedFiles({ type: "tool_execution_start", toolName: "edit", args: { path: "a.ts" } })).toEqual(["a.ts"]);
    expect(rpcEditedFiles({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } })).toEqual([]);
    expect(patchFiles("*** Update File: a\n*** Move to: b\n")).toEqual(["a", "b"]);
  });
});
