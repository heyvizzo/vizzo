import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { DEFAULT_CONFIG, type RunConfig } from "../../shared/config.ts";
import type { ServerMsg } from "../../shared/protocol.ts";
import type { ThreadAnchor } from "../../shared/threads.ts";
import { setBrowserUrl } from "../browserPage.ts";
import { centralSession, continueConversationSession } from "../centralSession.ts";
import { ConnectionState } from "../connection.ts";
import { getConversation } from "../conversation.ts";
import { Session } from "../session.ts";
import { resetThreadStore } from "../threads/store.ts";
import { createFakeDeps, DEFAULT_SCENARIO, FAST_TIMING, type FakeScenario } from "./fakes.ts";
import { cancelJobs, stopJob } from "./jobs.ts";
import { createPipelineOrchestrator } from "./pipeline.ts";
import type { TurnContext } from "./types.ts";

const pointed: { anchor: ThreadAnchor | null } = { anchor: null };
vi.mock("../../shared/anchor.ts", async (original) => ({
  ...(await original<typeof import("../../shared/anchor.ts")>()),
  inferAnchor: () => pointed.anchor,
  anchorTitle: () => "the red button",
}));

const RED: ThreadAnchor = {
  pageUrl: "http://localhost/demo.html", selector: "#red", domPath: "body > #red", dataSource: null,
  label: "Get started", text: "Get started", role: null, tag: "button", bounds: { x: 0, y: 0, width: 100, height: 40 },
};
let store = resetThreadStore();
const connections: ConnectionState[] = [];
const sockets: EventEmitter[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  store = resetThreadStore();
  pointed.anchor = null;
});
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.emit("close");
  for (const c of connections.splice(0)) c.disposeAll();
  store.reset();
  setBrowserUrl(null);
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers();
  vi.useRealTimers();
});

function setup(config: Partial<RunConfig> = {}, scenario: Partial<FakeScenario> = {}, solverMs = 30_000) {
  const events: ServerMsg[] = [];
  const connection = new ConnectionState();
  connections.push(connection);
  const d = createFakeDeps({ ...FAST_TIMING, solverFirstMs: solverMs }, {
    ...DEFAULT_SCENARIO, intent: "task", estimateS: 1, target: { kind: "central" }, ...scenario,
  });
  const solver = vi.spyOn(d, "solveInThread");
  const ctx: TurnContext = {
    turnId: "slow-turn", typedText: "Remove the dotted line", chat: true,
    config: {
      ...DEFAULT_CONFIG, approach: "pipeline", memory: true, backgroundLongTasks: true, longTaskSeconds: 20,
      silent: true, ...config,
    },
    send: (m) => events.push(m), sendAudio: () => {}, mark: () => {},
    cursorSamples: () => [], tAudioStart: () => undefined, connection,
    channel: {
      send: (m) => events.push(m), sendAudio: () => {}, whenIdle: () => Promise.resolve(),
      isIdle: () => true, setNoticeAbort: () => {},
    },
  };
  const orch = createPipelineOrchestrator(d);
  const start = (context = ctx) => {
    const turn = orch(context);
    turn.onRelease();
    return turn;
  };
  const jobs = () => events.filter((e) => e.type === "job").map((e) => e.job);
  const decisions = () => events.filter((e) => e.type === "decision");
  return { ctx, d, solver, events, connection, start, jobs, decisions };
}

describe("underestimated foreground work", () => {
  it("keeps the promoted task's native session on its completed card for both resume paths", async () => {
    const s = setup();
    const open = s.d.openThread!;
    const release = vi.fn(async () => {});
    s.d.openThread = (o) => {
      const h = open(o);
      Object.defineProperties(h, {
        spec: { value: { role: "solver", harness: "claude-code", model: "pinned", system: "", project: "/project" } },
        session: { value: () => ({ id: `native-${h.id}` }) },
        release: { value: release },
      });
      return h;
    };
    const t = s.start();
    await vi.advanceTimersByTimeAsync(25_100);
    await t.done;
    const reserved = centralSession();
    await vi.advanceTimersByTimeAsync(100_000);
    const done = s.jobs().find((j) => j.state === "done")!;
    expect(done.session).toMatchObject({ provider: "claude-code", id: "native-thread#1", resumeCommand: expect.stringContaining("--resume") });
    expect(release).toHaveBeenCalledOnce();
    expect(s.d.log.threadClosed).toEqual([]);
    continueConversationSession(done.session!.id!);
    expect(centralSession()).not.toBe(reserved);
    expect(centralSession()?.session?.()?.id).toBe(done.session!.id);
  });

  it("keeps a 21.5-second answer in the foreground through the grace period", async () => {
    const s = setup({ silent: false }, { intent: "question" });
    s.d.solveInThread = async (o) => {
      await new Promise((resolve) => setTimeout(resolve, 21_500));
      o.onSpokenLine("The font is Instrument Sans.");
      o.onDelta("SPOKEN: The font is Instrument Sans.");
      return { text: "SPOKEN: The font is Instrument Sans.", usage: {}, filesTouched: [] };
    };
    const t = s.start();
    await vi.advanceTimersByTimeAsync(21_000);
    expect(s.jobs()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    const r = await t.done;
    expect(r.error).toBeUndefined();
    expect(r.voiceText).toContain("The font is Instrument Sans.");
    expect(r.voiceText).not.toContain("taking longer");
    expect(s.decisions()).toMatchObject([{ background: false }]);
    expect(s.jobs()).toEqual([]);
  });

  it("lets an answer already being spoken finish even when details exceed the grace period", async () => {
    const s = setup({ silent: false }, { intent: "question" }, 10_000);
    const t = s.start();
    await vi.advanceTimersByTimeAsync(26_000);
    expect(s.jobs()).toEqual([]);
    expect(s.events.some((e) => e.type === "voice.text" && e.delta.includes("cards"))).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await t.done;
    expect(r.error).toBeUndefined();
    expect(r.voiceText).not.toContain("taking longer");
    expect(s.events.some((e) => e.type === "audio.cut" && e.segment === "answer")).toBe(false);
    expect(s.events.some((e) => e.type === "notice")).toBe(false);
    expect(s.jobs()).toEqual([]);
  });

  it("still allows cancellation during the grace period", async () => {
    const s = setup();
    const t = s.start();
    await vi.advanceTimersByTimeAsync(22_000);
    t.cancel();
    expect((await t.done).error).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(100_000);
    expect(s.jobs()).toEqual([]);
    expect(s.d.log.threadAborts).toHaveLength(1);
  });

  it("hands the same central request to a visible job after the grace period, then reports its late result once", async () => {
    const s = setup();
    const t = s.start();
    await vi.advanceTimersByTimeAsync(100);
    const handle = centralSession();
    expect(s.jobs()).toEqual([]);
    expect(s.decisions()).toMatchObject([{ background: false }]);
    await vi.advanceTimersByTimeAsync(25_000);
    const r = await t.done;
    expect(r.error).toBeUndefined();
    expect(r.voiceText).toContain("taking longer than expected");
    expect(r.usage.anthropic).not.toHaveProperty("solver");
    expect(s.decisions()).toMatchObject([{ background: false }, { background: true }]);
    expect(s.jobs()).toMatchObject([{ state: "running", turnId: "slow-turn", elapsedMs: expect.any(Number) }]);
    expect(s.jobs()[0]!.elapsedMs).toBeGreaterThanOrEqual(25_000);
    expect(s.solver).toHaveBeenCalledOnce();
    expect(s.solver.mock.calls[0]![0].timeoutMs).toBe(15 * 60_000);
    expect(s.d.log.threadSends).toHaveLength(1);
    expect(s.d.log.threadAborts).toEqual([]);
    expect(centralSession()).not.toBe(handle);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(s.jobs().map((j) => j.state)).toEqual(["running", "done"]);
    expect(s.jobs()[1]!.spoken).toBeTruthy();
    expect(s.jobs()[1]!.costItems).toHaveLength(1);
    expect(s.jobs()[1]!.elapsedMs).toBeGreaterThan(60_000);
    expect(s.events.some((e) => e.type === "error" || e.type === "notice")).toBe(false); // silent turn stays silent
    expect(s.events.some((e) => e.type === "llm.response" && e.response.target === "solver")).toBe(true);
    expect(getConversation().filter((c) => c.turnId === s.jobs()[0]!.jobId)).toHaveLength(1);
    expect(s.d.log.threadClosed).toEqual([s.d.log.threadSends[0]!.threadId]);
  });

  it("the next central turn runs independently while the promoted solver keeps working", async () => {
    const s = setup();
    const t = s.start();
    await vi.advanceTimersByTimeAsync(100);
    const execution = s.solver.mock.calls[0]![0].execution!;
    expect(execution.writer).toEqual({ kind: "central", id: s.ctx.turnId });
    const originalId = execution.id;
    await vi.advanceTimersByTimeAsync(25_000);
    await t.done;
    expect(execution.writer).toEqual({ kind: "job", id: s.jobs()[0]!.jobId });
    expect(execution.id).toBe(originalId);
    expect(s.solver).toHaveBeenCalledOnce();
    const runningId = s.d.log.threadSends[0]!.threadId;
    const next = s.start({ ...s.ctx, turnId: "next-turn", typedText: "What else can we change?" });
    await vi.advanceTimersByTimeAsync(100);
    expect(s.d.log.threadSends).toHaveLength(2);
    expect(s.solver.mock.calls[1]![0].execution?.id).not.toBe(originalId);
    expect(s.d.log.threadSends[1]).toMatchObject({ fork: runningId });
    expect(s.d.log.threadSends[1]!.threadId).not.toBe(runningId);
    expect(s.jobs().at(-1)!.state).toBe("running");
    expect(s.d.log.threadAborts).toEqual([]);
    next.cancel();
    await next.done;
    expect(s.d.log.threadAborts).not.toContain(runningId);
  });

  it("delivers the handoff, subsequent turn and late result through the actual Session protocol", async () => {
    const s = setup({ routerMode: "auto" });
    class Socket extends EventEmitter {
      readonly OPEN = 1;
      readyState = 1;
      sent: ServerMsg[] = [];
      send(data: string | Buffer): void { if (typeof data === "string") this.sent.push(JSON.parse(data)); }
      client(msg: object): void { this.emit("message", Buffer.from(JSON.stringify(msg)), false); }
    }
    const ws = new Socket();
    sockets.push(ws);
    new Session(ws as unknown as WebSocket, { persist: false, orchestrators: { pipeline: createPipelineOrchestrator(s.d) } });
    const start = (turnId: string) => {
      ws.client({ type: "turn.start", turnId, config: s.ctx.config, text: "Remove the dotted line", chat: true, tPress: performance.now() });
      ws.client({ type: "turn.release", turnId, tRelease: performance.now() });
    };
    start("first");
    await vi.advanceTimersByTimeAsync(26_000);
    const first = ws.sent.find((m) => m.type === "turn.done");
    expect(first).toMatchObject({ turnId: "first", run: { markMeta: { "turn.end": { promoted: true, background: true } } } });
    if (first?.type === "turn.done") expect(first.run.error).toBeUndefined();
    expect(ws.sent.filter((m) => m.type === "job")).toMatchObject([{ job: { state: "running" } }]);
    s.d.routeTurn = createFakeDeps(FAST_TIMING, { ...DEFAULT_SCENARIO, delegate: false }).routeTurn;
    start("second");
    await vi.advanceTimersByTimeAsync(100);
    expect(ws.sent.filter((m) => m.type === "turn.done").map((m) => m.turnId)).toEqual(["first", "second"]);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(ws.sent.filter((m) => m.type === "job").map((m) => m.job.state)).toEqual(["running", "done"]);
    expect(s.d.log.threadSends).toHaveLength(1);
    expect(getConversation().filter((c) => c.user.startsWith("(Background task finished:"))).toHaveLength(1);
  });

  it("adopts a one-shot solver when persistent harness sessions are unavailable", async () => {
    const s = setup();
    const solveTask = vi.fn(s.d.solveTask);
    const { openThread: _open, solveInThread: _solve, ...withoutSessions } = s.d;
    const t = createPipelineOrchestrator({ ...withoutSessions, solveTask })(s.ctx);
    t.onRelease();
    await vi.advanceTimersByTimeAsync(25_100);
    expect((await t.done).error).toBeUndefined();
    const signal = solveTask.mock.calls[0]![0].signal;
    expect(solveTask).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(false);
    stopJob(s.connection, s.ctx.channel!, s.jobs()[0]!.jobId);
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(s.jobs().map((j) => j.state)).toEqual(["running", "stopped"]);
    expect(s.d.log.threadSends).toEqual([]);
  });

  it("an element run keeps its thread and page marker, then announces its result as a thread update", async () => {
    pointed.anchor = RED;
    const s = setup({ threads: true }, { target: { kind: "new" }, threadRunMs: 90_000 });
    s.ctx.chat = false;
    const t = s.start();
    await vi.advanceTimersByTimeAsync(100);
    const id = store.list()[0]!.threadId;
    await vi.advanceTimersByTimeAsync(25_000);
    expect((await t.done).error).toBeUndefined();
    expect(s.decisions()).toMatchObject([{ threadId: id, background: false }, { threadId: id, background: true }]);
    expect(store.list()).toHaveLength(1);
    expect(store.info(id)).toMatchObject({ state: "running", anchor: { selector: "#red" } });
    expect(store.info(id)!.messages.at(-1)!.text).toContain("taking longer than expected");
    expect(s.jobs()).toEqual([]);
    expect(s.d.log.threadSends).toHaveLength(1);
    expect(s.d.log.threadAborts).toEqual([]);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(store.info(id)).toMatchObject({ state: "pending", unread: true });
    expect(store.info(id)!.messages.filter((m) => m.kind === "result")).toHaveLength(1);
    expect(store.info(id)!.costItems).toHaveLength(1);
    expect(store.conversation.filter((c) => c.user === "(Task update)")).toHaveLength(1);
  });

  it("finishing before the threshold cancels the handoff", async () => {
    const s = setup({}, {}, 5);
    const t = s.start();
    await vi.advanceTimersByTimeAsync(100);
    expect((await t.done).error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.jobs()).toEqual([]);
    expect(s.decisions()).toMatchObject([{ background: false }]);
    expect(s.d.log.threadSends).toHaveLength(1);
  });

  it("cancelling before the threshold stops the foreground request and prevents a late handoff", async () => {
    const s = setup();
    const t = s.start();
    await vi.advanceTimersByTimeAsync(19_000);
    t.cancel();
    expect((await t.done).error).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(100_000);
    expect(s.d.log.threadAborts).toHaveLength(1);
    expect(s.jobs()).toEqual([]);
    expect(s.decisions()).toHaveLength(1);
  });

  it("stopping a promoted job stops the original request and suppresses its result", async () => {
    const s = setup();
    const t = s.start();
    await vi.advanceTimersByTimeAsync(25_100);
    await t.done;
    const replacement = centralSession();
    const id = s.jobs()[0]!.jobId;
    expect(stopJob(s.connection, s.ctx.channel!, id)).toBe(true);
    expect(stopJob(s.connection, s.ctx.channel!, id)).toBe(false);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(s.jobs().map((j) => j.state)).toEqual(["running", "stopped"]);
    expect(s.d.log.threadAborts).toContain(s.d.log.threadSends[0]!.threadId);
    expect(centralSession()).toBe(replacement);
    expect(getConversation().some((c) => c.user.startsWith("(Background task finished:"))).toBe(false);
  });

  it("resetting promoted work aborts it and drops late completion", async () => {
    const s = setup();
    const t = s.start();
    await vi.advanceTimersByTimeAsync(25_100);
    await t.done;
    cancelJobs(s.connection);
    store.reset();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(s.jobs().map((j) => j.state)).toEqual(["running"]);
    expect(s.d.log.threadClosed).toContain(s.d.log.threadSends[0]!.threadId);
    expect(getConversation()).toEqual([]);
  });

  it("a late solver failure is reported on the job, after the foreground turn ended successfully", async () => {
    const s = setup({}, { failIn: "solver" });
    const t = s.start();
    await vi.advanceTimersByTimeAsync(25_100);
    expect((await t.done).error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(s.jobs()).toMatchObject([{ state: "running" }, { state: "failed", error: "fake solver: 500" }]);
    expect(s.events.some((e) => e.type === "error")).toBe(false);
  });

  it("a threshold longer than a minute is honored without the old turn timeout firing", async () => {
    const s = setup({ longTaskSeconds: 90 }, {}, 60_000);
    const t = s.start();
    const done = vi.fn();
    void t.done.then(done);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(done).not.toHaveBeenCalled();
    expect(s.jobs()).toEqual([]);
    await vi.advanceTimersByTimeAsync(35_000);
    expect((await t.done).error).toBeUndefined();
    expect(s.jobs()[0]!.state).toBe("running");
  });

  it("without background mode, the solver still gets its configured task time limit", async () => {
    const s = setup({ backgroundLongTasks: false });
    const t = s.start();
    await vi.advanceTimersByTimeAsync(100_000);
    const r = await t.done;
    expect(r.error).toBeUndefined();
    expect(r.usage.anthropic).toHaveProperty("solver");
    expect(s.jobs()).toEqual([]);
    expect(s.decisions()).toMatchObject([{ background: false }]);
  });

  it("speaks the handoff, then announces the finished job once", async () => {
    const s = setup({ silent: false });
    const t = s.start();
    await vi.advanceTimersByTimeAsync(26_000);
    expect((await t.done).voiceText).toContain("taking longer than expected");
    expect(s.events.some((e) => e.type === "audio.segment" && e.segment === "answer")).toBe(true);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(s.events.filter((e) => e.type === "notice").map((e) => e.state)).toEqual(["start", "end"]);
  });

  it("writes the handoff line but doesn't read it out once the user went to another page", async () => {
    setBrowserUrl("http://localhost/demo.html");
    const s = setup({ silent: false });
    const t = s.start();
    await vi.advanceTimersByTimeAsync(10_000);
    setBrowserUrl("http://localhost/pricing.html");
    await vi.advanceTimersByTimeAsync(16_000);
    const r = await t.done;
    expect(r.error).toBeUndefined();
    expect(r.voiceText).toContain("taking longer than expected");
    expect(s.events.some((e) => e.type === "audio.segment" && e.segment === "answer")).toBe(false);
    expect(s.jobs()[0]!.state).toBe("running");
  });

  it("still reads the handoff out after moving within the same page (#fragment)", async () => {
    setBrowserUrl("http://localhost/demo.html");
    const s = setup({ silent: false });
    const t = s.start();
    await vi.advanceTimersByTimeAsync(10_000);
    setBrowserUrl("http://localhost/demo.html#faq");
    await vi.advanceTimersByTimeAsync(16_000);
    await t.done;
    expect(s.events.some((e) => e.type === "audio.segment" && e.segment === "answer")).toBe(true);
  });
});
