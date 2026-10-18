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
import { createPipelineOrchestrator } from "./pipeline.ts";
import type { Orchestrator, OrchestratorDeps, TurnContext, TurnResult } from "./types.ts";

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

describe("pipeline orchestrator", () => {
  it("forced: stt → pointing → router ack → solver answer, segments in order, sockets closed", async () => {
    const d = deps();
    const h = harness({ approach: "pipeline", routerMode: "forced" });
    const r = await runTurn(createPipelineOrchestrator(d), h.ctx);
    expect(r.error).toBeUndefined();
    expect(h.segments()).toEqual(["ack:start", "audio", "ack:end", "answer:start", "audio", "answer:end"]);
    expectOrdered(h.markNames(), ["stt.firstPartial", "stt.final", "pointing.resolved", "llm.request", "llm.firstToken", "llm.toolCall", "ack.ttsFirstByte", "solver.request", "solver.spokenReady", "answer.ttsFirstByte", "turn.end"]);
    const types = h.events.map((e) => e.type);
    expect(types.indexOf("stt.partial")).toBeLessThan(types.indexOf("stt.final"));
    expect(types.indexOf("stt.final")).toBeLessThan(types.indexOf("pointing.resolved"));
    expect(r.transcript).toBe(DEFAULT_SCENARIO.transcript);
    expect(r.pointing).toHaveLength(1);
    expect(r.voiceText).toBe(`Sure, checking that grid now. ${SPOKEN_LINE}`);
    expect(r.usage).toMatchObject({ anthropic: { router: expect.any(Object), solver: expect.any(Object) } });
    expect(r.usage.elevenChars).toBe(r.voiceText.length - 1);
    expect(r.usage.scribeSeconds).toBeCloseTo(0.5, 5);
    expect(h.meta("llm.request")).toMatchObject({ cold: false });
    expect(allClosed(d.log)).toBe(true);
  });

  it("typed comment: the text is the transcript, Scribe is never opened", async () => {
    const d = deps();
    const h = harness({ approach: "pipeline", routerMode: "forced" });
    const r = await runTurn(createPipelineOrchestrator(d), { ...h.ctx, typedText: "  make this bigger " }, 0);
    expect(r.error).toBeUndefined();
    expect(r.transcript).toBe("make this bigger");
    expect(h.events.find((e) => e.type === "stt.final")).toMatchObject({ text: "make this bigger", words: [{ text: "make", start: 0 }, { text: "this", start: 0.3 }, { text: "bigger", start: 0.6 }] });
    expect(r.pointing).toHaveLength(1);
    expect(d.log.opened.some((id) => /scribe/i.test(id))).toBe(false);
    expect(h.segments()).toEqual(["ack:start", "audio", "ack:end", "answer:start", "audio", "answer:end"]);
  });

  it("silent (typed comment): the reply is text only, no TTS socket, no audio", async () => {
    const d = deps();
    const h = harness({ approach: "pipeline", routerMode: "forced", silent: true, fillers: true });
    const r = await runTurn(createPipelineOrchestrator(d), { ...h.ctx, typedText: "make this bigger" }, 0);
    expect(r.error).toBeUndefined();
    expect(r.voiceText).toBe(`Sure, checking that grid now. ${SPOKEN_LINE}`);
    expect(h.events.some((e) => e.type === "voice.text")).toBe(true);
    expect(h.events.some((e) => e.type === "audio" || e.type === "audio.segment")).toBe(false);
    expect(d.log.opened.some((id) => /tts/i.test(id))).toBe(false);
  });

  it("auto, no delegation: the router's direct answer is the 'answer' segment (pre-warmed socket relabelled)", async () => {
    const d = deps({ delegate: false });
    const h = harness({ approach: "pipeline", routerMode: "auto" });
    const r = await runTurn(createPipelineOrchestrator(d), h.ctx);
    expect(r.error).toBeUndefined();
    expect(h.segments()).toEqual(["answer:start", "audio", "answer:end"]);
    expect(h.markNames()).toContain("answer.ttsFirstByte");
    expect(h.markNames()).not.toContain("ack.ttsFirstByte");
    expect(h.markNames()).not.toContain("solver.request");
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
    const d = createFakeDeps({ ...FAST_TIMING, solverFirstMs: 100 }, DEFAULT_SCENARIO);
    const h = harness({ approach: "pipeline" });
    const t = createPipelineOrchestrator(d)(h.ctx);
    for (let i = 0; i < 10; i++) t.onAudio(FRAME);
    await new Promise((r) => setTimeout(r, 5));
    t.onRelease();
    await new Promise((r) => setTimeout(r, 60)); // solver in flight, answer socket pre-opened
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
