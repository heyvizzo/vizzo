// Approach B in threads mode: the router's target sends the turn to a new thread, an existing one, a tell or central.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type RunConfig } from "../../shared/config.ts";
import type { ServerMsg } from "../../shared/protocol.ts";
import type { ThreadAnchor } from "../../shared/threads.ts";
import type { RouteTurnOpts } from "../adapters/types.ts";
import { ConnectionState } from "../connection.ts";
import { createFakeDeps, DEFAULT_SCENARIO, FAST_TIMING, type FakeScenario } from "../orchestrators/fakes.ts";
import { createPipelineOrchestrator } from "../orchestrators/pipeline.ts";
import type { ConnectionChannel, TurnContext, TurnResult } from "../orchestrators/types.ts";
import { Floor } from "./floor.ts";
import { submitRun } from "./runner.ts";
import { resetThreadStore, type ThreadStore } from "./store.ts";

// The anchor is whatever the test points at (the real inference is tested in shared/anchor.test.ts).
const pointed: { anchor: ThreadAnchor | null } = { anchor: null };
vi.mock("../../shared/anchor.ts", () => ({
  inferAnchor: () => pointed.anchor,
  matchAnchor: (a: ThreadAnchor, threads: { threadId: string; anchor: ThreadAnchor }[]) => threads.find((t) => t.anchor.selector === a.selector)?.threadId ?? null,
  anchorTitle: () => "the red button",
}));

const RED: ThreadAnchor = {
  pageUrl: "http://localhost/demo.html", selector: "#red", domPath: "body > #red", dataSource: null, label: "Get started", text: "Get started",
  role: null, tag: "button", bounds: { x: 0, y: 0, width: 100, height: 40 },
};
const FRAME = Buffer.alloc(960);
const THREADS: Partial<RunConfig> = { approach: "pipeline", memory: true, threads: true, fillers: false, backgroundLongTasks: true, longTaskSeconds: 20 };

let store: ThreadStore;
let floorSent: ServerMsg[];
beforeEach(() => {
  store = resetThreadStore();
  floorSent = [];
  pointed.anchor = RED;
  const floor = new Floor({ send: (m) => floorSent.push(m), sendAudio: () => {} }, { graceMs: 0, focused: () => store.focused() });
  store.subscribe({ send: (m) => floorSent.push(m), floor });
});

function setup(sc: Partial<FakeScenario>) {
  const events: ServerMsg[] = [];
  const channel: ConnectionChannel = { send: (m) => events.push(m), sendAudio: () => {}, whenIdle: () => Promise.resolve(), isIdle: () => true, setNoticeAbort: () => {} };
  const ctx: TurnContext = {
    turnId: "t1", config: { ...DEFAULT_CONFIG, ...THREADS }, mark: () => {}, send: (m) => events.push(m), sendAudio: () => {},
    cursorSamples: () => [], tAudioStart: () => 1000, connection: new ConnectionState(), channel,
  };
  const deps = createFakeDeps(FAST_TIMING, { ...DEFAULT_SCENARIO, threadRunMs: 20, ...sc });
  const routed: RouteTurnOpts[] = [];
  const route = deps.routeTurn;
  deps.routeTurn = (o) => { routed.push(o); return route(o); };
  const segments = () => events.filter((e) => e.type === "audio.segment" && e.state === "start").map((e) => (e as { segment: string }).segment);
  const decision = () => events.find((e): e is Extract<ServerMsg, { type: "decision" }> => e.type === "decision");
  return { ctx, deps, events, routed, segments, decision };
}

async function run(s: ReturnType<typeof setup>): Promise<TurnResult> {
  const h = createPipelineOrchestrator(s.deps)(s.ctx);
  for (let i = 0; i < 25; i++) h.onAudio(FRAME);
  await new Promise((r) => setTimeout(r, 5));
  h.onRelease();
  return h.done;
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};
const says = () => floorSent.filter((m): m is Extract<ServerMsg, { type: "thread.say" }> => m.type === "thread.say" && m.state === "start").map((m) => m.say);

describe("pipeline (B) with element threads", () => {
  it("the router gets the thread briefs and the pointed element", async () => {
    const existing = store.create(RED, "the red button", "task");
    const s = setup({ target: { kind: "thread", threadId: existing.threadId, relation: "followup" }, intent: "task", estimateS: 30 });
    await run(s);
    expect(s.routed[0]!.anchorLabel).toBe("the red button");
    expect(s.routed[0]!.threads).toEqual([{ threadId: existing.threadId, title: "the red button", state: "idle", summary: "", onCurrentPage: false, underCursor: true }]);
  });

  it("new + short question: a thread is created and answered inline, in its session", async () => {
    const s = setup({ target: { kind: "new" }, estimateS: 8 });
    const r = await run(s);
    expect(r.error).toBeUndefined();
    const [t] = store.list();
    expect(t).toMatchObject({ title: "the red button", state: "idle", unread: false });
    expect(s.decision()).toMatchObject({ threadId: t!.threadId, background: false });
    expect(s.segments()).toEqual(["ack", "answer"]);
    expect(r.voiceText).toMatch(/Done: Why is the features section a CSS grid\?$/);
    expect(t!.messages.map((m) => m.kind)).toEqual(["request", "ack", "result"]);
    expect(s.deps.log.threadSends).toMatchObject([{ kind: "request" }]);
    expect(t!.costItems).toBeUndefined(); // the turn's own record carries the cost
  });

  it("new + long task: ack only; the run goes on and its result is spoken on the floor", async () => {
    const s = setup({ target: { kind: "new" }, intent: "task", estimateS: 120 });
    const r = await run(s);
    const [t] = store.list();
    expect(s.decision()).toMatchObject({ threadId: t!.threadId, background: true, intent: "task" });
    expect(s.segments()).toEqual(["ack"]);
    expect(r.solverText).toBe("");
    await until(() => says().length === 1);
    expect(says()[0]).toMatchObject({ threadId: t!.threadId, needsReply: false });
    await until(() => store.info(t!.threadId)!.state === "idle" && !store.info(t!.threadId)!.unread);
    expect(store.conversation.map((c) => c.assistant)).toEqual([
      "Started a task on the red button: Why is the features section a CSS grid?",
      expect.stringMatching(/^Red button task finished: Done:/),
    ]);
  });

  it("follow-up on an existing thread: queued behind its run, recorded, focused", async () => {
    const t = store.create(RED, "the red button", "task");
    const d0 = createFakeDeps(FAST_TIMING, { ...DEFAULT_SCENARIO, threadRunMs: 80 });
    const first = submitRun(t.threadId, { kind: "request", question: "make it bigger", turnId: "t0", config: DEFAULT_CONFIG, intent: "task" }, d0);
    const before = store.info(t.threadId)!.lastInteractionAt;
    await new Promise((r) => setTimeout(r, 2));
    const s = setup({ target: { kind: "thread", threadId: t.threadId, relation: "followup" }, intent: "task", estimateS: 10 });
    await run(s);
    expect(s.decision()).toMatchObject({ threadId: t.threadId, background: true });
    expect(store.info(t.threadId)!.lastInteractionAt).toBeGreaterThan(before);
    expect(store.info(t.threadId)!.messages.map((m) => m.kind)).toEqual(["followup", "ack"]);
    expect(await first).not.toBeNull(); // not aborted
    // Same harness session (opened by the first run), one request after the other.
    await until(() => d0.log.threadSends.length === 2);
    expect(d0.log.threadSends.map((x) => x.kind)).toEqual(["request", "followup"]);
  });

  it("correction: the running request is stopped and restarted with the combined request", async () => {
    const s = setup({ intent: "task", estimateS: 10, threadRunMs: 200 });
    const t = store.create(RED, "the red button", "task");
    const first = submitRun(t.threadId, { kind: "request", question: "make it red", turnId: "t0", config: DEFAULT_CONFIG, intent: "task" }, s.deps);
    await until(() => s.deps.log.threadSends.length === 1);
    s.deps.routeTurn = createFakeDeps(FAST_TIMING, { ...DEFAULT_SCENARIO, intent: "task", estimateS: 10, target: { kind: "thread", threadId: t.threadId, relation: "correction" } }).routeTurn;
    await run(s);
    expect(await first).toBeNull();
    expect(s.deps.log.threadAborts).toHaveLength(1);
    await until(() => s.deps.log.threadSends.length === 2);
    expect(s.deps.log.threadSends[1]).toMatchObject({ kind: "correction" });
    expect(s.deps.log.threadSends[1]!.question).toContain("\"make it red\"");
  });

  it("tell: the thread's latest result is the turn's answer; the thread counts as told", async () => {
    const t = store.create(RED, "the red button", "task");
    store.addMessage(t.threadId, { turnId: "t0", role: "assistant", kind: "result", text: "It's bigger, with rounder corners.", detail: "SPOKEN: …\n\nPadding 16px." }, (x) => {
      x.state = "pending"; x.unread = true; x.awaitingReply = true;
    });
    const s = setup({ tell: t.threadId });
    const r = await run(s);
    expect(s.decision()).toMatchObject({ intent: "answer", threadId: t.threadId, background: false });
    expect(s.segments()).toEqual(["answer"]);
    expect(r.voiceText).toBe("It's bigger, with rounder corners.");
    expect(r.solverText).toContain("Padding 16px.");
    expect(store.info(t.threadId)).toMatchObject({ state: "idle", unread: false, awaitingReply: false });
    expect(s.deps.log.threadSends).toEqual([]);
  });

  it("nothing pointed: target new goes to the central conversation (a background job when long)", async () => {
    pointed.anchor = null;
    const s = setup({ target: { kind: "new" }, intent: "task", estimateS: 120 });
    await run(s);
    expect(store.list()).toEqual([]);
    expect(s.decision()).toMatchObject({ background: true });
    expect(s.decision()!.threadId).toBeUndefined();
    await until(() => s.events.some((e) => e.type === "job" && e.job.state === "done"));
  });

  it("a thread's panel is open: the turn goes to it, whatever the router or the cursor say", async () => {
    const open = store.create(RED, "the red button", "task");
    const other = store.create({ ...RED, selector: "#blue" }, "the blue button", "task");
    pointed.anchor = { ...RED, selector: "#blue" };
    const s = setup({ target: { kind: "thread", threadId: other.threadId, relation: "followup" }, intent: "question", estimateS: 3 });
    s.ctx.pinnedThread = open.threadId;
    await run(s);
    expect(s.routed[0]!.threads!.map((t) => t.threadId)).toEqual([open.threadId]);
    expect(s.decision()?.threadId).toBe(open.threadId);
    expect(store.info(open.threadId)!.messages.some((m) => m.role === "user")).toBe(true);
    expect(store.info(other.threadId)!.messages).toEqual([]);
  });

  it("threads off: no briefs to the router, no threads", async () => {
    const s = setup({ estimateS: 8 });
    s.ctx.config = { ...s.ctx.config, threads: false };
    await run(s);
    expect(s.routed[0]!.threads).toBeUndefined();
    expect(store.list()).toEqual([]);
  });
});
