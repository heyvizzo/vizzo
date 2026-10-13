// Chat-mode behaviour: decisions, fillers on short tasks, background jobs on long ones, clarify.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type RunConfig } from "../../shared/config.ts";
import type { ServerMsg } from "../../shared/protocol.ts";
import { ConnectionState } from "../connection.ts";
import { getConversation } from "../conversation.ts";
import { createFakeDeps, DEFAULT_SCENARIO, FAST_TIMING, FILLER_LINES, type FakeScenario } from "./fakes.ts";
import { createPipelineOrchestrator } from "./pipeline.ts";
import { BACKGROUND_TOOL_RESULT, createRealtimeOrchestrator } from "./realtime.ts";
import type { ConnectionChannel, Orchestrator, TurnContext, TurnResult } from "./types.ts";

const FRAME = Buffer.alloc(960);
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

const deps = (sc: Partial<FakeScenario>, opusFirstMs = 3) =>
  createFakeDeps({ ...FAST_TIMING, opusFirstMs }, { ...DEFAULT_SCENARIO, ...sc });

describe("pipeline (B) in chat mode", () => {
  it("short question: decision, then filler lines while Opus is slow, then the answer", async () => {
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

  it("fast Opus: no fillers", async () => {
    const s = setup({ approach: "pipeline" });
    await run(createPipelineOrchestrator(deps({ estimateS: 8 })), s.ctx);
    expect(s.segments()).toEqual(["ack", "answer"]);
  });

  it("long task: ack only, Opus runs as a background job, result announced and added to the conversation", async () => {
    const s = setup({ approach: "pipeline" });
    const r = await run(createPipelineOrchestrator(deps({ intent: "task", estimateS: 120 })), s.ctx);
    expect(s.decision()).toMatchObject({ intent: "task", estimateS: 120, background: true });
    expect(s.segments()).toEqual(["ack"]);
    expect(r.opusText).toBe("");
    await until(() => s.channelEvents.some((e) => e.type === "notice" && e.state === "end"));
    const jobs = s.channelEvents.filter((e) => e.type === "job").map((e) => (e as Extract<ServerMsg, { type: "job" }>).job);
    // running → done (Opus finished, with its cost) → done again once the spoken result's cost is added
    expect(jobs.map((j) => j.state)).toEqual(["running", "done", "done"]);
    // DEFAULT_CONFIG routes Claude through claude -p: the Opus call is on the subscription ($0 billed, savedUsd set).
    expect(jobs[1]!.costItems!.map((c) => c.label)).toEqual(["Opus (background task · claude -p · subscription)"]);
    expect(jobs[1]!.costItems![0]!.usd).toBe(0);
    expect(jobs[1]!.costItems![0]!.savedUsd).toBeGreaterThan(0);
    expect(jobs[2]!.costItems!.map((c) => c.label)).toEqual(["Opus (background task · claude -p · subscription)", expect.stringMatching(/^ElevenLabs TTS \(spoken result/)]);
    expect(jobs[2]!.costUsd).toBeCloseTo(jobs[2]!.costItems!.reduce((n, c) => n + c.usd, 0), 10);
    expect(jobs[1]!.spoken).toBeTruthy();
    expect(jobs[1]!.turnId).toBe("t1");
    expect(s.noticeBytes()).toBeGreaterThan(0);
    expect(getConversation(s.connection).some((t) => t.turnId === jobs[1]!.jobId)).toBe(true);
  });

  it("clarify: a follow-up question, no Opus, spoken as the answer", async () => {
    const s = setup({ approach: "pipeline", routerMode: "auto" });
    const r = await run(createPipelineOrchestrator(deps({ intent: "clarify" })), s.ctx);
    expect(s.decision()).toMatchObject({ intent: "clarify", background: false });
    expect(s.segments()).toEqual(["answer"]);
    expect(r.voiceText).toMatch(/\?$/);
    expect(r.opusText).toBe("");
  });

  it("benchmark config (no chat flags): long estimate still runs inline", async () => {
    const s = setup({ approach: "pipeline", memory: false, fillers: false, backgroundLongTasks: false });
    const r = await run(createPipelineOrchestrator(deps({ intent: "task", estimateS: 120 })), s.ctx);
    expect(s.decision()).toMatchObject({ background: false });
    expect(s.segments()).toEqual(["ack", "answer"]);
    expect(r.opusText).not.toBe("");
  });
});

describe("realtime (A) in chat mode", () => {
  it("long task: tool output recorded without a response, job started, no answer segment", async () => {
    const s = setup({ approach: "realtime" });
    const d = deps({ intent: "task", estimateS: 90 });
    await run(createRealtimeOrchestrator(d), s.ctx);
    expect(s.decision()).toMatchObject({ intent: "task", estimateS: 90, background: true });
    expect(d.log.sentToolResults).toEqual([{ callId: expect.any(String), output: BACKGROUND_TOOL_RESULT, respond: false }]);
    expect(s.segments()).toEqual(["ack"]);
    await until(() => s.channelEvents.some((e) => e.type === "job" && e.job.state === "done"));
    // The realtime session is idle, so it speaks the notice itself.
    await until(() => d.log.spoken.some((x) => x.kind === "notice"));
  });

  it("short question with slow Opus: filler lines spoken by the realtime voice before the answer", async () => {
    const s = setup({ approach: "realtime" });
    const d = deps({ estimateS: 10 }, 900);
    await run(createRealtimeOrchestrator(d), s.ctx);
    expect(d.log.spoken.filter((x) => x.kind === "filler").length).toBeGreaterThan(0);
    const segs = s.segments();
    expect(segs[0]).toBe("ack");
    expect(segs).toContain("filler");
    expect(segs[segs.length - 1]).toBe("answer");
  }, 10_000);

  it("no tool call and a question mark: decision clarify", async () => {
    const s = setup({ approach: "realtime" });
    await run(createRealtimeOrchestrator(deps({ intent: "clarify" })), s.ctx);
    expect(s.decision()).toMatchObject({ intent: "clarify", background: false });
  });
});

describe("prompt capture (llm.prompt)", () => {
  const targets = (events: ServerMsg[]) => events.filter((e) => e.type === "llm.prompt").map((e) => (e as Extract<ServerMsg, { type: "llm.prompt" }>).prompt.target);

  it("B sends the router, fillers and Opus prompts for the turn", async () => {
    const s = setup({ approach: "pipeline" });
    await run(createPipelineOrchestrator(deps({ estimateS: 8 }, 300)), s.ctx);
    expect(targets(s.events)).toEqual(["router", "fillers", "opus"]);
    expect(s.events.find((e) => e.type === "llm.prompt")).toMatchObject({ turnId: "t1" });
  });

  it("A sends the Realtime prompt (instructions, audio, context) and then Opus", async () => {
    const s = setup({ approach: "realtime", fillers: false });
    await run(createRealtimeOrchestrator(deps({ estimateS: 8 })), s.ctx);
    expect(targets(s.events)).toEqual(["realtime", "opus"]);
    const rt = (s.events.find((e) => e.type === "llm.prompt") as Extract<ServerMsg, { type: "llm.prompt" }>).prompt;
    expect(rt.system[0]!.label).toMatch(/realtime\.md/);
    expect(rt.messages.some((m) => m.label === "this turn · audio" && /0\.5 s/.test(m.text))).toBe(true);
  });

  it("a background job's Opus prompt goes out on the channel with its jobId", async () => {
    const s = setup({ approach: "pipeline" });
    await run(createPipelineOrchestrator(deps({ intent: "task", estimateS: 120 })), s.ctx);
    await until(() => s.channelEvents.some((e) => e.type === "llm.prompt"));
    const p = s.channelEvents.find((e) => e.type === "llm.prompt") as Extract<ServerMsg, { type: "llm.prompt" }>;
    expect(p).toMatchObject({ turnId: "t1", jobId: expect.any(String), prompt: { target: "opus" } });
  });
});


describe("response capture (llm.response)", () => {
  type P = Extract<ServerMsg, { type: "llm.prompt" }>;
  type R = Extract<ServerMsg, { type: "llm.response" }>;
  it("every B call's response carries its prompt's callId", async () => {
    const s = setup({ approach: "pipeline" });
    await run(createPipelineOrchestrator(deps({ estimateS: 8 }, 300)), s.ctx);
    const prompts = s.events.filter((e): e is P => e.type === "llm.prompt");
    const responses = s.events.filter((e): e is R => e.type === "llm.response");
    expect(responses.map((r) => r.response.target)).toEqual(["router", "fillers", "opus"]);
    for (const r of responses) expect(prompts.find((p) => p.callId === r.callId)?.prompt.target).toBe(r.response.target);
    expect(responses[2]!.response).toMatchObject({ stopReason: "end_turn", usage: { cache_read_input_tokens: 5000 } });
  });

  it("A: one Realtime response per response.done (ack, answer), all on the Realtime call", async () => {
    const s = setup({ approach: "realtime", fillers: false });
    await run(createRealtimeOrchestrator(deps({ estimateS: 8 })), s.ctx);
    const rtPrompt = s.events.find((e): e is P => e.type === "llm.prompt" && e.prompt.target === "realtime")!;
    const rt = s.events.filter((e): e is R => e.type === "llm.response" && e.response.target === "realtime");
    expect(rt.map((r) => r.response.label)).toEqual(["ack", "answer"]);
    expect(rt.every((r) => r.callId === rtPrompt.callId)).toBe(true);
  });
});
