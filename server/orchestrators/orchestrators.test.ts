import { describe, expect, it, vi } from "vitest";

// shared/pointing.ts is a stub until T9 lands; give it deterministic behaviour so injection is observable.
vi.mock("../../shared/pointing.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/pointing.ts")>()),
  resolvePointing: (words: { text: string; start: number }[]) =>
    words.filter((w) => /^this\b/i.test(w.text)).map((w) => ({
      word: w.text, wordStart: w.start, algorithm: "dwellMode",
      sample: { t: 0, x: 1, y: 2, scrollX: 0, scrollY: 0, elementPath: "section", dataSource: "demo.html:34", label: "Features" },
    })),
  formatPointingContext: (targets: { word: string }[]) =>
    targets.map((t) => `Pointing: "${t.word}" → <section> "Features" [data-source=demo.html:34]`).join("\n"),
}));

import { DEFAULT_CONFIG, type RunConfig } from "../../shared/config.ts";
import type { MarkName } from "../../shared/marks.ts";
import type { ServerMsg } from "../../shared/protocol.ts";
import { ConnectionState } from "../connection.ts";
import { createFakeDeps, DEFAULT_SCENARIO, FAST_TIMING, SPOKEN_LINE, type FakeScenario } from "./fakes.ts";
import { createHybridOrchestrator } from "./hybrid.ts";
import { createPipelineOrchestrator } from "./pipeline.ts";
import { CANCELLED_TOOL_RESULT, createRealtimeOrchestrator, TOOL_RESULT_NOTE } from "./realtime.ts";
import type { Orchestrator, OrchestratorDeps, TurnContext, TurnResult } from "./types.ts";
import type { RealtimeUsage } from "../adapters/types.ts";

type Ev = ServerMsg | { type: "audio"; bytes: number };

function harness(config: Partial<RunConfig>, connection = new ConnectionState()) {
  const events: Ev[] = [];
  const marks: { name: MarkName; meta?: Record<string, unknown> }[] = [];
  const ctx: TurnContext = {
    turnId: "t1",
    config: { ...DEFAULT_CONFIG, ...config },
    mark: (name, meta) => { marks.push({ name, meta }); },
    send: (m) => events.push(m),
    sendAudio: (b) => events.push({ type: "audio", bytes: b.length }),
    cursorSamples: () => [],
    tAudioStart: () => 1000,
    connection,
  };
  const markNames = () => marks.map((m) => m.name);
  const meta = (n: MarkName) => marks.find((m) => m.name === n)?.meta;
  /** Segment events + audio collapsed: ["ack:start", "audio", "ack:end", ...] with runs of audio merged. */
  const segments = () => {
    const out: string[] = [];
    for (const e of events) {
      const s = e.type === "audio" ? "audio" : e.type === "audio.segment" ? `${e.segment}:${e.state}` : null;
      if (s && !(s === "audio" && out[out.length - 1] === "audio")) out.push(s);
    }
    return out;
  };
  return { ctx, events, marks, markNames, meta, segments, connection };
}

const FRAME = Buffer.alloc(960); // 20 ms PCM16 24 kHz

async function runTurn(orch: Orchestrator, ctx: TurnContext, frames = 25): Promise<TurnResult> {
  const h = orch(ctx);
  for (let i = 0; i < frames; i++) h.onAudio(FRAME);
  await new Promise((r) => setTimeout(r, 5)); // let pre-warm sockets open
  h.onRelease();
  return h.done;
}

const deps = (sc: Partial<FakeScenario> = {}, extra: Partial<OrchestratorDeps> = {}) =>
  ({ ...createFakeDeps(FAST_TIMING, { ...DEFAULT_SCENARIO, ...sc }), ...extra });

const allClosed = (log: { opened: string[]; closed: string[] }, except: RegExp[] = []) =>
  log.opened.filter((id) => !except.some((re) => re.test(id))).every((id) => log.closed.includes(id));

function expectOrdered(names: MarkName[], order: MarkName[]) {
  const idx = order.map((n) => names.indexOf(n));
  for (const [i, v] of idx.entries()) expect(v, `mark ${order[i]} missing`).toBeGreaterThanOrEqual(0);
  for (let i = 1; i < idx.length; i++) expect(idx[i]!, `${order[i]} before ${order[i - 1]}`).toBeGreaterThan(idx[i - 1]!);
}

describe("realtime orchestrator (A)", () => {
  it("delegates: ack segment, tool result as soon as the spoken line is ready, answer segment", async () => {
    const d = deps();
    const h = harness({ approach: "realtime" });
    const r = await runTurn(createRealtimeOrchestrator(d), h.ctx);
    expect(r.error).toBeUndefined();
    expect(h.segments()).toEqual(["ack:start", "audio", "ack:end", "answer:start", "audio", "answer:end"]);
    expectOrdered(h.markNames(), ["llm.request", "llm.firstToken", "ack.ttsFirstByte", "llm.toolCall", "opus.request", "opus.firstToken", "opus.spokenReady", "answer.ttsFirstByte", "turn.end"]);
    expect(h.markNames()).toContain("opus.done");
    expect(d.log.sentToolResults).toEqual([{ callId: expect.any(String), output: `${SPOKEN_LINE}\n\n${TOOL_RESULT_NOTE}` }]);
    expect(r.ackIsAnswer).toBeUndefined();
    expect(r.opusText).toContain("display: grid");
    expect(r.voiceText).toContain(SPOKEN_LINE);
    expect(h.events.filter((e) => e.type === "opus.text").length).toBeGreaterThan(1);
    expect((r.usage.openai as RealtimeUsage).responses).toHaveLength(2);
    expect((r.usage.anthropic as { opus: unknown }).opus).toBeTruthy();
    expect(h.meta("llm.request")).toMatchObject({ cold: false, reused: false });
    expect(r.transcript).toBe("");
  });

  it("answers directly: one segment, flagged ackIsAnswer so TTA = TTFA", async () => {
    const h = harness({ approach: "realtime" });
    const r = await runTurn(createRealtimeOrchestrator(deps({ delegate: false })), h.ctx);
    expect(h.segments()).toEqual(["ack:start", "audio", "ack:end"]);
    expect(r.ackIsAnswer).toBe(true);
    expect(h.markNames()).not.toContain("opus.request");
  });

  it("reuses one session per connection across turns; reopens when the model changes", async () => {
    const d = deps();
    const conn = new ConnectionState();
    const orch = createRealtimeOrchestrator(d);
    const h1 = harness({ approach: "realtime" }, conn);
    const r1 = await runTurn(orch, h1.ctx);
    const h2 = harness({ approach: "realtime" }, conn);
    const r2 = await runTurn(orch, h2.ctx);
    expect(d.log.opened.filter((id) => id.startsWith("realtime"))).toHaveLength(1);
    expect(h2.meta("llm.request")).toMatchObject({ reused: true, cold: false });
    // usage is per turn even though the session's counters are cumulative
    expect((r1.usage.openai as RealtimeUsage).totals.inputTokens).toBe(200);
    expect((r2.usage.openai as RealtimeUsage).totals.inputTokens).toBe(200);
    const h3 = harness({ approach: "realtime", realtimeModel: "gpt-realtime-2.1-mini" }, conn);
    await runTurn(orch, h3.ctx);
    expect(d.log.opened.filter((id) => id.startsWith("realtime"))).toHaveLength(2);
    expect(d.log.closed.filter((id) => id.startsWith("realtime"))).toHaveLength(1);
    conn.disposeAll();
    await new Promise((r) => setTimeout(r, 1));
    expect(allClosed(d.log)).toBe(true);
  });

  it("prewarm off: opens a session for the turn on release (cold) and closes it after", async () => {
    const d = deps();
    const h = harness({ approach: "realtime", prewarm: false });
    const r = await runTurn(createRealtimeOrchestrator(d), h.ctx);
    expect(r.error).toBeUndefined();
    expect(h.meta("llm.request")).toMatchObject({ cold: true });
    expect(allClosed(d.log)).toBe(true);
  });

  it("cancel while Opus works: response cancelled, pending call closed, session kept for the next turn", async () => {
    const conn = new ConnectionState();
    const d = createFakeDeps({ ...FAST_TIMING, opusFirstMs: 50 }, DEFAULT_SCENARIO);
    const orch = createRealtimeOrchestrator(d);
    const h = harness({ approach: "realtime" }, conn);
    const t = orch(h.ctx);
    await new Promise((r) => setTimeout(r, 5));
    t.onRelease();
    await new Promise((r) => setTimeout(r, 30));
    t.cancel();
    const r = await t.done;
    expect(r.error).toBe("cancelled");
    expect(conn.get("realtime")).toBeDefined();
    expect(d.log.cancels).toBe(1);
    expect(d.log.sentToolResults).toEqual([{ callId: expect.any(String), output: CANCELLED_TOOL_RESULT, respond: false }]);
  });

  it("realtime error → error {source: openai}, done with error, never hangs", async () => {
    const d = deps({ failIn: "realtime-response" });
    const h = harness({ approach: "realtime" });
    const r = await runTurn(createRealtimeOrchestrator(d), h.ctx);
    expect(r.error).toMatch(/^openai:/);
    expect(h.events.find((e) => e.type === "error")).toMatchObject({ source: "openai" });
    expect(allClosed(d.log)).toBe(true);
  });

  it("opus error → error {source: opus}", async () => {
    const d = deps({ failIn: "opus" });
    const h = harness({ approach: "realtime" });
    const r = await runTurn(createRealtimeOrchestrator(d), h.ctx);
    expect(r.error).toMatch(/^opus:/);
    expect(h.events.find((e) => e.type === "error")).toMatchObject({ source: "opus" });
  });
});

describe("pipeline orchestrator (B)", () => {
  it("forced: stt → pointing → haiku ack → opus answer, segments in order, sockets closed", async () => {
    const d = deps();
    const h = harness({ approach: "pipeline", routerMode: "forced" });
    const r = await runTurn(createPipelineOrchestrator(d), h.ctx);
    expect(r.error).toBeUndefined();
    expect(h.segments()).toEqual(["ack:start", "audio", "ack:end", "answer:start", "audio", "answer:end"]);
    expectOrdered(h.markNames(), ["stt.firstPartial", "stt.final", "pointing.resolved", "llm.request", "llm.firstToken", "llm.toolCall", "ack.ttsFirstByte", "opus.request", "opus.spokenReady", "answer.ttsFirstByte", "turn.end"]);
    const types = h.events.map((e) => e.type);
    expect(types.indexOf("stt.partial")).toBeLessThan(types.indexOf("stt.final"));
    expect(types.indexOf("stt.final")).toBeLessThan(types.indexOf("pointing.resolved"));
    expect(r.transcript).toBe(DEFAULT_SCENARIO.transcript);
    expect(r.pointing).toHaveLength(1);
    expect(r.voiceText).toBe(`Sure, checking that grid now. ${SPOKEN_LINE}`);
    expect(r.usage).toMatchObject({ anthropic: { haiku: expect.any(Object), opus: expect.any(Object) } });
    expect(r.usage.elevenChars).toBe(r.voiceText.length - 1);
    expect(r.usage.scribeSeconds).toBeCloseTo(0.5, 5);
    expect(h.meta("llm.request")).toMatchObject({ cold: false });
    expect(allClosed(d.log)).toBe(true);
  });

  it("auto, no delegation: Haiku's direct answer is the 'answer' segment (pre-warmed socket relabelled)", async () => {
    const d = deps({ delegate: false });
    const h = harness({ approach: "pipeline", routerMode: "auto" });
    const r = await runTurn(createPipelineOrchestrator(d), h.ctx);
    expect(r.error).toBeUndefined();
    expect(h.segments()).toEqual(["answer:start", "audio", "answer:end"]);
    expect(h.markNames()).toContain("answer.ttsFirstByte");
    expect(h.markNames()).not.toContain("ack.ttsFirstByte");
    expect(h.markNames()).not.toContain("opus.request");
  });

  it("auto with delegation labels the router speech 'ack'", async () => {
    const h = harness({ approach: "pipeline", routerMode: "auto" });
    await runTurn(createPipelineOrchestrator(deps({ delegate: true })), h.ctx);
    expect(h.segments()).toEqual(["ack:start", "audio", "ack:end", "answer:start", "audio", "answer:end"]);
  });

  it("prewarm off: sockets opened inside the turn (cold) and still closed", async () => {
    const d = deps();
    const h = harness({ approach: "pipeline", prewarm: false });
    const r = await runTurn(createPipelineOrchestrator(d), h.ctx);
    expect(r.error).toBeUndefined();
    expect(h.meta("llm.request")).toMatchObject({ cold: true });
    expect(allClosed(d.log)).toBe(true);
  });

  it("cancel closes every socket opened for the turn", async () => {
    const d = createFakeDeps({ ...FAST_TIMING, opusFirstMs: 100 }, DEFAULT_SCENARIO);
    const h = harness({ approach: "pipeline" });
    const t = createPipelineOrchestrator(d)(h.ctx);
    for (let i = 0; i < 10; i++) t.onAudio(FRAME);
    await new Promise((r) => setTimeout(r, 5));
    t.onRelease();
    await new Promise((r) => setTimeout(r, 60)); // opus in flight, answer socket pre-opened
    t.cancel();
    expect((await t.done).error).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 10));
    expect(d.log.opened.some((id) => id.startsWith("tts:answer"))).toBe(true);
    expect(allClosed(d.log)).toBe(true);
  });

  it("tts failure → error {source: tts}", async () => {
    const d = deps({ failIn: "tts" });
    const h = harness({ approach: "pipeline" });
    const r = await runTurn(createPipelineOrchestrator(d), h.ctx);
    expect(r.error).toMatch(/^tts:/);
    expect(h.events.find((e) => e.type === "error")).toMatchObject({ source: "tts" });
    expect(allClosed(d.log)).toBe(true);
  });

  it("overall turn timeout fires when an adapter hangs", async () => {
    const d = deps({ scribeHangs: true }, { turnTimeoutMs: 50 });
    const h = harness({ approach: "pipeline" });
    const r = await runTurn(createPipelineOrchestrator(d), h.ctx);
    expect(r.error).toMatch(/^timeout:/);
    expect(h.events.find((e) => e.type === "error")).toMatchObject({ source: "timeout" });
    expect(allClosed(d.log)).toBe(true);
  });
});

describe("hybrid orchestrator (C)", () => {
  it("waits for Scribe, resolves pointing and injects it before response.create", async () => {
    const d = deps();
    const h = harness({ approach: "hybrid", hybridWaitMs: 200 });
    const r = await runTurn(createHybridOrchestrator(d), h.ctx);
    expect(r.error).toBeUndefined();
    expectOrdered(h.markNames(), ["stt.final", "pointing.resolved", "llm.request", "ack.ttsFirstByte", "answer.ttsFirstByte", "turn.end"]);
    expect(d.log.contexts).toHaveLength(1);
    expect(d.log.contexts[0]!.split("\n")[0]).toBe(`Pointing: "this" → <section> "Features" [data-source=demo.html:34]`);
    expect(d.log.contexts[0]).toContain("reply in English");
    expect(h.meta("llm.request")).toMatchObject({ pointingInjected: true, pointingMissed: false });
    expect(h.meta("pointing.resolved")).not.toHaveProperty("pointingMissed");
    expect(r.transcript).toBe(DEFAULT_SCENARIO.transcript);
    expect(r.usage.scribeSeconds).toBeCloseTo(0.5, 5);
    expect(h.segments()).toEqual(["ack:start", "audio", "ack:end", "answer:start", "audio", "answer:end"]);
    expect(allClosed(d.log, [/^realtime/])).toBe(true);
  });

  it("timeout: responds without context, records the late pointing as missed", async () => {
    const d = createFakeDeps({ ...FAST_TIMING, sttFinalMs: 40 }, DEFAULT_SCENARIO);
    const h = harness({ approach: "hybrid", hybridWaitMs: 10 });
    const r = await runTurn(createHybridOrchestrator(d), h.ctx);
    expect(r.error).toBeUndefined();
    expect(d.log.contexts).toEqual([undefined]);
    expect(h.meta("llm.request")).toMatchObject({ pointingInjected: false, pointingMissed: true });
    expect(h.meta("pointing.resolved")).toMatchObject({ pointingMissed: true, late: true });
    expect(r.pointing).toHaveLength(1); // still recorded
    expectOrdered(h.markNames(), ["llm.request", "pointing.resolved"]);
  });

  it("hybridWaitMs 0 does not wait; Scribe never arriving is recorded and bounded", async () => {
    const d = deps({ scribeHangs: true }, { hybridLateWaitMs: 20 });
    const h = harness({ approach: "hybrid", hybridWaitMs: 0 });
    const r = await runTurn(createHybridOrchestrator(d), h.ctx);
    expect(r.error).toBeUndefined();
    expect(h.meta("pointing.resolved")).toMatchObject({ pointingMissed: true, arrived: false });
    expect(d.log.contexts).toEqual([undefined]);
  });

  it("scribe failure is non-fatal: the voice reply still happens, error is recorded", async () => {
    const d = deps({ failIn: "scribe" });
    const h = harness({ approach: "hybrid", hybridWaitMs: 50 });
    const r = await runTurn(createHybridOrchestrator(d), h.ctx);
    expect(r.error).toMatch(/^scribe:/);
    expect(h.events.find((e) => e.type === "error")).toMatchObject({ source: "scribe" });
    expect(h.markNames()).toContain("answer.ttsFirstByte");
  });
});
