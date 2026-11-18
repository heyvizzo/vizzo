import type { DrawingAnnotation } from "../../shared/annotations.ts";
import { annotation } from "./drawing.fixture.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmChoice } from "../../shared/config.ts";
import { MAX_LIVE_THREAD_SESSIONS } from "../../shared/threads.ts";
import { claudeEditedFiles, codexEditedFiles, opencodeEditedFiles, patchFiles, projectRelative, rpcEditedFiles, SessionUnavailableError, type AgentSpec, type HarnessResult, type SessionRef, type SessionStart, type WarmAgent } from "./harnesses.ts";
import type { SessionDispatch } from "./types.ts";
import { liveHarnessSessions, openHarnessThread, withReplay } from "./harnessThread.ts";
import { configureWarm, registerRoleSpecs, setAgentFactory, setWarmLogger, stopWarm } from "./warmPool.ts";
import { centralSession, continueConversationSession, finishJobSession, openJobSession, solveCentral } from "../centralSession.ts";
import { resetConversation } from "../conversation.ts";
import { harnessSessionInfo } from "./sessionInfo.ts";
import { WriterRegistry } from "../changes/writers.ts";

const SMART: LlmChoice = { provider: "claude-code", model: "claude-opus-5-5", level: "high" };
const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * A fake agent: each request waits until the test answers it (or aborts it). Like the real harnesses it saves its
 * session: a new one gets an id (`s1`, `s2`…), a resumed one keeps its id, a fork gets its own. A session in `gone`
 * can't be resumed or forked (the request fails before anything reaches it).
 */
class Fake implements WarmAgent {
  dead = false;
  keptAgent: boolean;
  messages: string[] = [];
  attachments: (readonly DrawingAnnotation[])[] = [];
  pending: { resolve: (r: HarnessResult) => void; reject: (e: Error) => void }[] = [];
  aborts = 0;
  private used = false;
  private ref: SessionRef;
  constructor(readonly spec: AgentSpec, readonly start: SessionStart | undefined, private hasAbort = true) {
    this.keptAgent = !!start;
    this.ref = start?.kind === "resume" ? start.ref : { id: `s${++sessionSeq}` };
    made.push(this);
  }
  alive() { return !this.dead; }
  ready() { return true; }
  keep() { this.keptAgent = true; return true; }
  session(): SessionRef | undefined { return nativeSessions && this.keptAgent && (this.used || this.start?.kind === "resume") ? this.ref : undefined; }
  request(user: string, onText: ((d: string) => void) | undefined, _timeoutMs?: number, annotations?: readonly DrawingAnnotation[]): Promise<HarnessResult> {
    if (this.start && this.start.kind !== "new" && gone.has(this.start.ref.id)) {
      this.dead = true;
      return Promise.reject(new SessionUnavailableError(`couldn't ${this.start.kind} session ${this.start.ref.id}: not found`));
    }
    this.used = true;
    this.messages.push(user);
    this.attachments.push(annotations ?? []);
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
/** The fake harness saves sessions (false: it has nothing to resume, as a harness without them would). */
let nativeSessions = true;
let sessionSeq = 0;
let gone = new Set<string>();

setWarmLogger(() => {});
beforeEach(() => {
  made = [];
  withAbort = true;
  nativeSessions = true;
  sessionSeq = 0;
  gone = new Set();
  registerRoleSpecs((role) => ({ system: `${role.toUpperCase()} system`, project: "/proj" }));
  setAgentFactory((s, start) => new Fake(s, start, withAbort));
});
afterEach(() => { resetConversation(); stopWarm(); setAgentFactory(null); vi.unstubAllEnvs(); });

const sessionsLeft: { close(): void }[] = [];
afterEach(() => { for (const t of sessionsLeft.splice(0)) t.close(); });
const open = (replay = () => "") => { const t = openHarnessThread({ role: "solver", choice: SMART, replay }); sessionsLeft.push(t); return t; };

describe("harness threads", () => {
  it("does not replay a tracked continuation into a fresh native session when the original is gone", async () => {
    const spec: AgentSpec = { role: "solver", harness: "claude-code", model: SMART.model, system: "S", persist: true };
    const session = openHarnessThread({ role: "solver", choice: SMART, replay: () => "HISTORY", restore: { spec, ref: { id: "gone" } } });
    sessionsLeft.push(session);
    const execution = new WriterRegistry().queue({
      writer: { kind: "thread", id: "t" }, title: "The button", request: "Change it", folder: null,
      purpose: "followup", continuesExecutionId: "unfinished",
    }, "gone");
    gone.add("gone");
    await expect(execution.run(() => session.send("Continue the request", undefined, 1000, undefined, undefined, execution))).rejects.toBeInstanceOf(SessionUnavailableError);
    expect(made).toHaveLength(1);
    expect(made[0]!.start).toEqual({ kind: "resume", ref: { id: "gone" } });
    expect(made[0]!.messages).toEqual([]);
  });

  it("resumes a completed main-conversation job on its saved native session after releasing its process", async () => {
    const handle = openJobSession(openHarnessThread, SMART, []);
    expect(harnessSessionInfo(handle)).toBeNull();
    const first = handle.send("original task", undefined, 1000);
    await until(() => !!made[0]?.pending.length);
    made[0]!.answer("original result");
    await first;
    await finishJobSession(handle);
    expect(handle.live).toBe(false);
    expect(handle.session?.()).toEqual({ id: "s1" });
    continueConversationSession("s1", "original task");
    const next = solveCentral({
      openThread: openHarnessThread,
      solveInThread: async (o) => o.thread.send(o.question, o.onDelta, 1000),
    }, { provider: "codex", model: "changed-setting" }, "followup", {
      mark: () => {}, question: "follow-up", pointing: [], onDelta: () => {}, onSpokenLine: () => {},
    });
    await until(() => !!made[1]?.pending.length);
    expect(centralSession()).toBe(handle);
    expect(made[1]!.start).toEqual({ kind: "resume", ref: { id: "s1" } });
    expect(made[1]!.spec.harness).toBe("claude-code");
    expect(made[1]!.messages[0]).toContain("Continuing an earlier task: original task");
    made[1]!.answer("follow-up result");
    await next;
  });

  it("publishes the native id as soon as output arrives, without repeating unchanged metadata", async () => {
    const refs: (SessionRef | undefined)[] = [];
    const t = openHarnessThread({ role: "solver", choice: SMART, replay: () => "", onSession: () => refs.push(t.session?.()) });
    sessionsLeft.push(t);
    const p = t.send("first", undefined, 1000);
    await until(() => !!made[0]?.pending.length);
    expect(refs).toEqual([undefined, { id: "s1" }]);
    made[0]!.answer("done");
    await p;
    const next = t.send("next", undefined, 1000);
    await until(() => !!made[0]?.pending.length);
    made[0]!.answer("done");
    await next;
    expect(refs).toEqual([undefined, { id: "s1" }]);
  });

  it("releases an idle connection for terminal resume and continues the same saved session later", async () => {
    const t = open();
    const p = t.send("first", undefined, 1000);
    await until(() => !!made[0]?.pending.length);
    made[0]!.answer("done");
    await p;
    await t.release?.();
    expect(t.live).toBe(false);
    expect(t.session?.()).toEqual({ id: "s1" });
    const next = t.send("later", undefined, 1000);
    await until(() => !!made[1]?.pending.length);
    expect(made[1]!.start).toEqual({ kind: "resume", ref: { id: "s1" } });
    made[1]!.answer("continued");
    expect(await next).toMatchObject({ session: { mode: "resumed", id: "s1" } });
  });

  it("waits for running work before releasing a connection copied for the terminal", async () => {
    const t = open();
    const p = t.send("working", undefined, 1000);
    await until(() => !!made[0]?.pending.length);
    const released = t.release?.();
    expect(t.live).toBe(true);
    expect(made[0]!.aborts).toBe(0);
    made[0]!.answer("finished normally");
    expect((await p).text).toBe("finished normally");
    await released;
    expect(t.live).toBe(false);
    expect(t.session?.()).toEqual({ id: "s1" });
  });

  it("waits for native release to finish before acknowledging handoff or resuming another Vizzo request", async () => {
    const t = open();
    const first = t.send("first", undefined, 1000);
    await until(() => !!made[0]?.pending.length);
    made[0]!.answer("done");
    await first;
    let unlock!: () => void;
    const nativeRelease = vi.fn(() => new Promise<void>((resolve) => { unlock = resolve; }));
    (made[0] as WarmAgent).release = nativeRelease;
    let ready = false;
    const released = t.release!().then(() => { ready = true; });
    const next = t.send("after handoff", undefined, 1000);
    await until(() => nativeRelease.mock.calls.length > 0);
    expect(ready).toBe(false);
    expect(made).toHaveLength(1);
    unlock();
    await released;
    await until(() => !!made[1]?.pending.length);
    expect(made[1]!.start).toEqual({ kind: "resume", ref: { id: "s1" } });
    made[1]!.answer("resumed");
    await next;
  });

  it("keeps what it was opened with: changed instructions (or model) apply to sessions opened after it", async () => {
    const t = open(() => "Earlier conversation");
    const first = t.send("first", undefined, 1000);
    await until(() => !!made[0]?.pending.length);
    registerRoleSpecs((role) => ({ system: `${role} updated instructions`, project: "/proj" }));
    const next = t.send("next", undefined, 1000);
    made[0]!.answer("first finished");
    expect((await first).text).toBe("first finished");
    // The same agent, untouched: no new process, no replay.
    await until(() => made[0]!.pending.length === 1);
    expect(made).toHaveLength(1);
    expect(made[0]!.dead).toBe(false);
    expect(made[0]!.messages[1]).toBe("next");
    made[0]!.answer("next finished");
    expect(await next).toMatchObject({ text: "next finished", reopened: false, session: { mode: "live" } });
    // Even resumed in a new process, it gets the prompt it was opened with.
    made[0]!.dead = true;
    const later = t.send("later", undefined, 1000);
    await until(() => !!made[1]?.pending.length);
    expect(made[1]!.spec.system).toBe("SOLVER system");
    made[1]!.answer("ok");
    await later;
    // A session opened now gets the new one.
    const fresh = open();
    const p = fresh.send("hi", undefined, 1000);
    await until(() => !!made[2]?.pending.length);
    expect(made[2]!.spec.system).toBe("solver updated instructions");
    made[2]!.answer("ok");
    await p;
  });

  it("replays historical images only when reopening and preserves each queued request's own drawing", async () => {
    nativeSessions = false; // nothing to resume: a new session is told the history, images included
    const previous = { ...annotation, id: "previous" };
    const current = { ...annotation, id: "current" };
    const t = openHarnessThread({ role: "solver", choice: SMART, replay: () => "Earlier drawing previous", replayAnnotations: () => [previous] });
    sessionsLeft.push(t);
    const first = t.send("move", undefined, 1000, [current]);
    await until(() => !!made[0]?.pending.length);
    expect(made[0]!.attachments[0]).toEqual([previous, current]);
    expect(made[0]!.messages[0]).toContain("Attached images, in order: previous, current");
    made[0]!.answer("done");
    await first;
    const next = t.send("further", undefined, 1000);
    await until(() => !!made[0]?.pending.length);
    expect(made[0]!.attachments[1]).toEqual([]);
    made[0]!.answer("done");
    await next;
    made[0]!.dead = true;
    const reopened = t.send("again", undefined, 1000);
    await until(() => made.length === 2 && !!made[1]?.pending.length);
    expect(made[1]!.attachments[0]).toEqual([previous]);
    made[1]!.answer("done");
    await reopened;
  });

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

  it("abort without an interrupt stops the process: the next send resumes the saved session, with no replay", async () => {
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
    expect(made[1]!.start).toEqual({ kind: "resume", ref: { id: "s1" } });
    expect(made[1]!.messages[0]).toBe("again");
    made[1]!.answer("ok");
    expect(await q).toMatchObject({ reopened: false, session: { mode: "resumed", id: "s1" } });
  });

  it("a session restored from disk resumes its saved session with the spec it was opened with", async () => {
    const spec: AgentSpec = { role: "solver", harness: "claude-code", model: "old-model", system: "OLD system", project: "/old-proj", persist: true };
    const t = openHarnessThread({ role: "solver", choice: SMART, replay: () => "HISTORY", restore: { spec, ref: { id: "saved-1" } } });
    sessionsLeft.push(t);
    expect(t.session?.()).toEqual({ id: "saved-1" });
    const q = t.send("continue", undefined, 1000);
    await until(() => made[0]?.pending.length === 1);
    expect(made[0]!.spec).toEqual(spec);
    expect(made[0]!.start).toEqual({ kind: "resume", ref: { id: "saved-1" } });
    expect(made[0]!.messages[0]).toBe("continue");
    made[0]!.answer("ok");
    expect(await q).toMatchObject({ reopened: false, session: { mode: "resumed", id: "saved-1" } });
  });

  it("a restored session without a saved id starts new and is told the history", async () => {
    const spec: AgentSpec = { role: "solver", harness: "claude-code", model: "m", system: "S", project: "/p", persist: true };
    const t = openHarnessThread({ role: "solver", choice: SMART, replay: () => "HISTORY", restore: { spec } });
    sessionsLeft.push(t);
    const q = t.send("continue", undefined, 1000);
    await until(() => made[0]?.pending.length === 1);
    expect(made[0]!.start).toEqual({ kind: "new" });
    expect(made[0]!.messages[0]).toBe(withReplay("HISTORY", "continue"));
    made[0]!.answer("ok");
    expect(await q).toMatchObject({ reopened: true });
  });

  it("a crashed session is resumed by id; errors reach the caller", async () => {
    const t = open(() => "H");
    const p = t.send("x", undefined, 1000);
    await until(() => made[0]?.pending.length === 1);
    made[0]!.kill();
    await expect(p).rejects.toThrow("killed");
    const q = t.send("y", undefined, 1000);
    await until(() => made[1]?.pending.length === 1);
    expect(made[1]!.start).toEqual({ kind: "resume", ref: { id: "s1" } });
    expect(made[1]!.messages[0]).toBe("y");
    made[1]!.answer("ok");
    expect(await q).toMatchObject({ reopened: false, session: { mode: "resumed", id: "s1" } });
    expect(t.session?.()).toEqual({ id: "s1" });
  });

  it("a saved session that can't be resumed: a new one is told the history, and the result says why", async () => {
    const t = open(() => "H");
    const p = t.send("x", undefined, 1000);
    await until(() => made[0]?.pending.length === 1);
    made[0]!.answer("ok");
    await p;
    made[0]!.dead = true; // evicted or crashed
    gone.add("s1");       // and its saved session was deleted meanwhile
    const sent: SessionDispatch[] = [];
    const q = t.send("y", undefined, 1000, undefined, (d) => sent.push(d));
    await until(() => made[2]?.pending.length === 1);
    expect(made[1]!.start).toEqual({ kind: "resume", ref: { id: "s1" } });
    expect(made[1]!.messages).toEqual([]); // nothing reached it
    expect(made[2]!.start).toEqual({ kind: "new" });
    expect(made[2]!.messages[0]).toBe(withReplay("H", "y"));
    made[2]!.answer("ok");
    const r = await q;
    expect(r).toMatchObject({ reopened: true, session: { mode: "replayed", id: "s2" } });
    expect(r.session!.fallback).toMatch(/couldn't resume session s1/);
    // The debug trace saw both dispatches, the second marked as a replay with the reason.
    expect(sent.map((d) => d.mode)).toEqual(["resumed", "replayed"]);
    expect(sent[1]).toMatchObject({ message: withReplay("H", "y"), fallback: expect.stringMatching(/s1/) });
    // From then on it is the new session that is continued.
    expect(t.session?.()).toEqual({ id: "s2" });
  });

  it("a session known to be gone before its agent starts falls back the same way", async () => {
    const t = open(() => "H");
    const p = t.send("x", undefined, 1000);
    await until(() => made[0]?.pending.length === 1);
    made[0]!.answer("ok");
    await p;
    made[0]!.dead = true;
    setAgentFactory((s, start) => {
      if (start?.kind === "resume") throw new SessionUnavailableError("couldn't resume session s1: its file is gone");
      return new Fake(s, start);
    });
    const q = t.send("y", undefined, 1000);
    await until(() => made[1]?.pending.length === 1);
    expect(made[1]!.messages[0]).toBe(withReplay("H", "y"));
    made[1]!.answer("ok");
    expect(await q).toMatchObject({ reopened: true, session: { mode: "replayed", fallback: expect.stringMatching(/file is gone/) } });
  });

  it("a request that fails on a resumed session is not sent again", async () => {
    const t = open(() => "H");
    const p = t.send("x", undefined, 1000);
    await until(() => made[0]?.pending.length === 1);
    made[0]!.answer("ok");
    await p;
    made[0]!.dead = true;
    const q = t.send("change the file", undefined, 1000);
    await until(() => made[1]?.pending.length === 1);
    made[1]!.pending.shift()!.reject(new Error("model overloaded"));
    await expect(q).rejects.toThrow("model overloaded");
    expect(made).toHaveLength(2); // no third agent, no replay of the task
  });

  it("a harness with nothing to resume gets the history replayed into a new session", async () => {
    nativeSessions = false;
    const t = open(() => "H");
    const p = t.send("x", undefined, 1000);
    await until(() => made[0]?.pending.length === 1);
    made[0]!.kill();
    await expect(p).rejects.toThrow("killed");
    const q = t.send("y", undefined, 1000);
    await until(() => made[1]?.pending.length === 1);
    expect(made[1]!.start).toEqual({ kind: "new" });
    expect(made[1]!.messages[0]).toBe(withReplay("H", "y"));
    made[1]!.answer("ok");
    expect(await q).toMatchObject({ reopened: true, session: { mode: "replayed" } });
  });

  it("a fork starts with another session's history and hears only the notes; without one to fork it is told the history", async () => {
    const source = open();
    const p = source.send("x", undefined, 1000);
    await until(() => made[0]?.pending.length === 1);
    made[0]!.answer("ok");
    await p;
    const fork = openHarnessThread({ role: "solver", choice: SMART, forkOf: source, replay: () => "ALL HISTORY", notes: () => "NOTES" });
    sessionsLeft.push(fork);
    const q = fork.send("long task", undefined, 1000);
    await until(() => made[1]?.pending.length === 1);
    expect(made[1]!.start).toEqual({ kind: "fork", ref: { id: "s1" } });
    expect(made[1]!.messages[0]).toBe(withReplay("NOTES", "long task"));
    made[1]!.answer("done");
    expect(await q).toMatchObject({ reopened: false, session: { mode: "forked", id: "s2" } });
    expect(source.session?.()).toEqual({ id: "s1" }); // untouched
    // A source that never ran has no session to fork.
    const empty = open();
    const lone = openHarnessThread({ role: "solver", choice: SMART, forkOf: empty, replay: () => "ALL HISTORY", notes: () => "NOTES" });
    sessionsLeft.push(lone);
    const r = lone.send("task", undefined, 1000);
    await until(() => made[2]?.pending.length === 1);
    expect(made[2]!.start).toEqual({ kind: "new" });
    expect(made[2]!.messages[0]).toBe(withReplay("ALL HISTORY", "task"));
    made[2]!.answer("done");
    expect(await r).toMatchObject({ reopened: true, session: { mode: "replayed" } });
  });

  it("a live session hears what happened elsewhere as notes before the request; none, nothing is added", async () => {
    let notes = "";
    const t = openHarnessThread({ role: "solver", choice: SMART, replay: () => "", notes: () => notes });
    sessionsLeft.push(t);
    const p = t.send("one", undefined, 1000);
    await until(() => made[0]?.pending.length === 1);
    expect(made[0]!.messages[0]).toBe("one"); // a new session with no history: just the request
    made[0]!.answer("ok");
    await p;
    notes = "A thread finished.";
    const q = t.send("two", undefined, 1000);
    await until(() => made[0]!.pending.length === 1);
    expect(made[0]!.messages[1]).toBe(withReplay("A thread finished.", "two"));
    made[0]!.answer("ok");
    await q;
    notes = "";
    const r = t.send("three", undefined, 1000);
    await until(() => made[0]!.pending.length === 1);
    expect(made[0]!.messages[2]).toBe("three");
    made[0]!.answer("ok");
    await r;
  });

  it(`keeps at most ${MAX_LIVE_THREAD_SESSIONS} live sessions: the least recently used idle one is stopped, and resumed when needed`, async () => {
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
    // The evicted thread's saved session is resumed: no replay.
    const back = threads[1]!.send("back", undefined, 1000);
    await until(() => made.length === MAX_LIVE_THREAD_SESSIONS + 2 && made.at(-1)!.pending.length === 1);
    expect(made.at(-1)!.start).toEqual({ kind: "resume", ref: { id: "s2" } });
    expect(made.at(-1)!.messages[0]).toBe("back");
    made.at(-1)!.answer("ok");
    expect(await back).toMatchObject({ reopened: false, session: { mode: "resumed", id: "s2" } });
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

  it("close ends the session for good; its saved session is still known (the user can resume it in a terminal)", async () => {
    const t = open();
    const p = t.send("x", undefined, 1000);
    await until(() => made[0]?.pending.length === 1);
    t.close();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(made[0]!.dead).toBe(true);
    expect(t.live).toBe(false);
    expect(t.session?.()).toEqual({ id: "s1" });
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

describe("codex thread (fake app-server)", () => {
  it("sets immediate unloading and waits for thread/closed while other sessions remain usable", async () => {
    const project = mkdtempSync(join(tmpdir(), "vizzo-codex-release-"));
    const log = join(project, "protocol.jsonl");
    vi.stubEnv("CODEX_BIN", fileURLToPath(new URL("./__fixtures__/fake-codex-session.mjs", import.meta.url)));
    vi.stubEnv("FIXTURE_CODEX_LOG", log);
    setAgentFactory(null);
    registerRoleSpecs(() => ({ system: "SOLVER", project }));
    const t = openHarnessThread({ role: "solver", choice: { provider: "codex", model: "fake" }, replay: () => "" });
    const other = openHarnessThread({ role: "solver", choice: { provider: "codex", model: "fake" }, replay: () => "" });
    sessionsLeft.push(t, other);
    try {
      await t.send("hello", undefined, 5000);
      await other.send("keep this session", undefined, 5000);
      await t.release!();
      const events = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(events.find((e) => e.method === "thread/start").params.config.thread_unload_delay_secs).toBe(0);
      expect(events.some((e) => e.method === "thread/closed" && e.threadId === "fake-codex-1")).toBe(true);
      expect(t.live).toBe(false);
      expect(other.live).toBe(true);
      expect((await other.send("still here", undefined, 5000)).session?.id).toBe("fake-codex-2");
      await other.release!();
    } finally { stopWarm(); rmSync(project, { recursive: true, force: true }); }
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
