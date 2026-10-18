// Chat-mode behaviour: decisions, fillers on short tasks, background jobs on long ones, clarify.
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type RunConfig } from "../../shared/config.ts";
import type { ServerMsg } from "../../shared/protocol.ts";
import { ConnectionState } from "../connection.ts";
import { getConversation, resetConversation } from "../conversation.ts";
import { createFakeDeps, DEFAULT_SCENARIO, FAST_TIMING, FILLER_LINES, type FakeScenario } from "./fakes.ts";
import { createPipelineOrchestrator } from "./pipeline.ts";
import type { ConnectionChannel, Orchestrator, TurnContext, TurnResult } from "./types.ts";

const FRAME = Buffer.alloc(960);
// The conversation is process-level now: start every test from an empty one.
beforeEach(() => resetConversation());
const CHAT: Partial<RunConfig> = { memory: true, fillers: true, backgroundLongTasks: true, longTaskSeconds: 20 };

function setup(config: Partial<RunConfig>) {
  const events: ServerMsg[] = [];
  const channelEvents: ServerMsg[] = [];
  let noticeBytes = 0;
  const connection = new ConnectionState();
  const channel: ConnectionChannel = {
    send: (m) => channelEvents.push(m),
    sendAudio: (b) => { noticeBytes += b.length; },
    whenIdle: () => Promise.resolve(),
    isIdle: () => true,
    setNoticeAbort: () => {},
  };
  const ctx: TurnContext = {
    turnId: "t1", config: { ...DEFAULT_CONFIG, ...CHAT, ...config }, mark: () => {},
    send: (m) => events.push(m), sendAudio: () => {}, cursorSamples: () => [], tAudioStart: () => 1000,
    connection, channel,
  };
  const segments = () => events.filter((e) => e.type === "audio.segment" && e.state === "start").map((e) => (e as { segment: string }).segment);
  const decision = () => events.find((e) => e.type === "decision") as Extract<ServerMsg, { type: "decision" }> | undefined;
  return { ctx, events, channelEvents, segments, decision, connection, noticeBytes: () => noticeBytes };
}

async function run(orch: Orchestrator, ctx: TurnContext): Promise<TurnResult> {
  const h = orch(ctx);
  for (let i = 0; i < 25; i++) h.onAudio(FRAME);
  await new Promise((r) => setTimeout(r, 5));
  h.onRelease();
  return h.done;
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const deps = (sc: Partial<FakeScenario>, solverFirstMs = 3) =>
  createFakeDeps({ ...FAST_TIMING, solverFirstMs }, { ...DEFAULT_SCENARIO, ...sc });

describe("pipeline in chat mode", () => {
  it("short question: decision, then filler lines while the solver is slow, then the answer", async () => {
    const s = setup({ approach: "pipeline" });
    const r = await run(createPipelineOrchestrator(deps({ estimateS: 8 }, 900)), s.ctx);
    expect(r.error).toBeUndefined();
    expect(s.decision()).toMatchObject({ intent: "question", estimateS: 8, background: false });
    const segs = s.segments();
    expect(segs[0]).toBe("ack");
    expect(segs).toContain("filler");
    expect(segs[segs.length - 1]).toBe("answer");
    expect(r.voiceText).toContain(FILLER_LINES[0]);
  }, 10_000);

  it("fast solver: no fillers", async () => {
    const s = setup({ approach: "pipeline" });
    await run(createPipelineOrchestrator(deps({ estimateS: 8 })), s.ctx);
    expect(s.segments()).toEqual(["ack", "answer"]);
  });

  it("long task: ack only, the solver runs as a background job, result announced and added to the conversation", async () => {
    const s = setup({ approach: "pipeline" });
    const r = await run(createPipelineOrchestrator(deps({ intent: "task", estimateS: 120 })), s.ctx);
    expect(s.decision()).toMatchObject({ intent: "task", estimateS: 120, background: true });
    expect(s.segments()).toEqual(["ack"]);
    expect(r.solverText).toBe("");
    await until(() => s.channelEvents.some((e) => e.type === "notice" && e.state === "end"));
    const jobs = s.channelEvents.filter((e) => e.type === "job").map((e) => (e as Extract<ServerMsg, { type: "job" }>).job);
    // running → done (the solver finished, with its cost) → done again once the spoken result's cost is added
    expect(jobs.map((j) => j.state)).toEqual(["running", "done", "done"]);
    // DEFAULT_CONFIG routes the smart tier through Claude Code: the solver call is on the subscription ($0 billed, savedUsd set).
    expect(jobs[1]!.costItems!.map((c) => c.label)).toEqual(["Background solver · claude-opus-5-5 (Claude Code · subscription)"]);
    expect(jobs[1]!.costItems![0]!.usd).toBe(0);
    expect(jobs[1]!.costItems![0]!.savedUsd).toBeGreaterThan(0);
    expect(jobs[2]!.costItems!.map((c) => c.label)).toEqual(["Background solver · claude-opus-5-5 (Claude Code · subscription)", expect.stringMatching(/^ElevenLabs TTS \(spoken result/)]);
    expect(jobs[2]!.costUsd).toBeCloseTo(jobs[2]!.costItems!.reduce((n, c) => n + c.usd, 0), 10);
    expect(jobs[1]!.spoken).toBeTruthy();
    expect(jobs[1]!.turnId).toBe("t1");
    expect(s.noticeBytes()).toBeGreaterThan(0);
    expect(getConversation(s.connection).some((t) => t.turnId === jobs[1]!.jobId)).toBe(true);
  });

  it("clarify: a follow-up question, no solver, spoken as the answer", async () => {
    const s = setup({ approach: "pipeline", routerMode: "auto" });
    const r = await run(createPipelineOrchestrator(deps({ intent: "clarify" })), s.ctx);
    expect(s.decision()).toMatchObject({ intent: "clarify", background: false });
    expect(s.segments()).toEqual(["answer"]);
    expect(r.voiceText).toMatch(/\?$/);
    expect(r.solverText).toBe("");
  });

  it("benchmark config (no chat flags): long estimate still runs inline", async () => {
    const s = setup({ approach: "pipeline", memory: false, fillers: false, backgroundLongTasks: false });
    const r = await run(createPipelineOrchestrator(deps({ intent: "task", estimateS: 120 })), s.ctx);
    expect(s.decision()).toMatchObject({ background: false });
    expect(s.segments()).toEqual(["ack", "answer"]);
    expect(r.solverText).not.toBe("");
  });

  it("always-listen with no words does not call the router", async () => {
    const s = setup({ approach: "pipeline" });
    s.ctx.autoEndpoint = () => true;
    const r = await run(createPipelineOrchestrator(deps({ transcript: "", words: [] })), s.ctx);
    expect(s.decision()).toBeUndefined();
    expect(r.transcript).toBe("");
    expect(r.voiceText).toBe("");
    expect(s.segments()).toEqual([]);
  });
});

describe("prompt capture (llm.prompt)", () => {
  const targets = (events: ServerMsg[]) => events.filter((e) => e.type === "llm.prompt").map((e) => (e as Extract<ServerMsg, { type: "llm.prompt" }>).prompt.target);

  it("sends the router, fillers and solver prompts for the turn", async () => {
    const s = setup({ approach: "pipeline" });
    await run(createPipelineOrchestrator(deps({ estimateS: 8 }, 300)), s.ctx);
    expect(targets(s.events)).toEqual(["router", "fillers", "solver"]);
    expect(s.events.find((e) => e.type === "llm.prompt")).toMatchObject({ turnId: "t1" });
  });

  it("a background job's solver prompt goes out on the channel with its jobId", async () => {
    const s = setup({ approach: "pipeline" });
    await run(createPipelineOrchestrator(deps({ intent: "task", estimateS: 120 })), s.ctx);
    await until(() => s.channelEvents.some((e) => e.type === "llm.prompt"));
    const p = s.channelEvents.find((e) => e.type === "llm.prompt") as Extract<ServerMsg, { type: "llm.prompt" }>;
    expect(p).toMatchObject({ turnId: "t1", jobId: expect.any(String), prompt: { target: "solver" } });
  });
});


describe("response capture (llm.response)", () => {
  type P = Extract<ServerMsg, { type: "llm.prompt" }>;
  type R = Extract<ServerMsg, { type: "llm.response" }>;
  it("every call's response carries its prompt's callId", async () => {
    const s = setup({ approach: "pipeline" });
    await run(createPipelineOrchestrator(deps({ estimateS: 8 }, 300)), s.ctx);
    const prompts = s.events.filter((e): e is P => e.type === "llm.prompt");
    const responses = s.events.filter((e): e is R => e.type === "llm.response");
    expect(responses.map((r) => r.response.target)).toEqual(["router", "fillers", "solver"]);
    for (const r of responses) expect(prompts.find((p) => p.callId === r.callId)?.prompt.target).toBe(r.response.target);
    expect(responses[2]!.response).toMatchObject({ stopReason: "end_turn", usage: { cache_read_input_tokens: 5000 } });
  });

});
