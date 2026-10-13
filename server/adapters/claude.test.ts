import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CursorSample, PointingTarget } from "../../shared/protocol.ts";
import type { MarkName } from "../../shared/marks.ts";
import {
  ClaudeRefusalError, ROUTER_TOOL, type ClaudeClient, formatPointingForPrompt, loadFixtureContext,
  routeWithHaiku, setClient, setLogger, solveWithOpus,
} from "./claude.ts";

// ── Mock SDK stream ────────────────────────────────────────────────────────

type Ev = Record<string, unknown>;
interface FakeStream { [Symbol.asyncIterator](): AsyncIterator<Ev>; finalMessage(): Promise<unknown> }

function fakeStream(events: Ev[], final: Record<string, unknown>, failWith?: unknown): FakeStream {
  return {
    async *[Symbol.asyncIterator]() {
      if (failWith) throw failWith;
      for (const e of events) {
        await Promise.resolve();
        yield e;
      }
    },
    finalMessage: () => (failWith ? Promise.reject(failWith) : Promise.resolve(final)),
  };
}

const usage = (o: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, speed: null, ...o,
});

const textDelta = (index: number, text: string): Ev => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
const jsonDelta = (index: number, partial_json: string): Ev => ({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json } });

function mockClient(opts: { messages?: FakeStream[]; beta?: FakeStream[] }) {
  const messagesStream = vi.fn((_params: unknown, _o?: unknown) => {
    const s = opts.messages?.shift();
    if (!s) throw new Error("unexpected messages.stream call");
    return s;
  });
  const betaStream = vi.fn((_params: unknown, _o?: unknown) => {
    const s = opts.beta?.shift();
    if (!s) throw new Error("unexpected beta.messages.stream call");
    return s;
  });
  const client = { messages: { stream: messagesStream }, beta: { messages: { stream: betaStream } } } as unknown as ClaudeClient;
  return { client, messagesStream, betaStream };
}

function recorder() {
  const marks: { name: MarkName; meta?: Record<string, unknown> }[] = [];
  return { marks, mark: (name: MarkName, meta?: Record<string, unknown>) => { marks.push({ name, meta }); }, names: () => marks.map((m) => m.name) };
}

const sample = (o: Partial<CursorSample>): CursorSample => ({
  t: 1000, x: 10, y: 10, scrollX: 0, scrollY: 0, elementPath: null, dataSource: null, label: null, ...o,
});
const GRID_TARGETS: PointingTarget[] = [
  { word: "this", wordStart: 0.42, algorithm: "atStart", sample: sample({ elementPath: "body > main > section#features > h2", label: "Features heading", dataSource: "web/cursor/demo/demo.html:33" }) },
  { word: "this", wordStart: 0.42, algorithm: "dwellMode", sample: sample({ elementPath: "body > main > section#features > div.card-grid", label: "Feature card grid", dataSource: "web/cursor/demo/demo.html:34" }) },
];
const U3 = "Why is this section built with a grid instead of flexbox?";

let logs: string[] = [];
beforeEach(() => { logs = []; setLogger((m) => logs.push(m)); });
afterEach(() => { setClient(null); setLogger((m) => console.info(m)); });

// ── formatPointingForPrompt ────────────────────────────────────────────────

describe("formatPointingForPrompt", () => {
  it("prefers dwellMode and formats tag, label and data-source", () => {
    expect(formatPointingForPrompt(GRID_TARGETS)).toBe(`Pointing: "this" → <div> "Feature card grid" [data-source=web/cursor/demo/demo.html:34]`);
  });
  it("one line per word, in spoken order; strips punctuation; handles unresolved", () => {
    const t: PointingTarget[] = [
      { word: "there.", wordStart: 1.2, algorithm: "dwell", sample: null },
      { word: "this", wordStart: 0.3, algorithm: "dwell", sample: sample({ elementPath: "article.card", label: "Card: Alerts", dataSource: null }) },
    ];
    expect(formatPointingForPrompt(t)).toBe(`Pointing: "this" → <article> "Card: Alerts"\nPointing: "there" → (no element resolved)`);
  });
  it("says so when there is nothing", () => {
    expect(formatPointingForPrompt([])).toMatch(/^Pointing: none/);
  });
});

// ── routeWithHaiku ─────────────────────────────────────────────────────────

describe("routeWithHaiku", () => {
  const toolStart: Ev = { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "ask_opus", input: {} } };
  const input = { ack: "Good question, checking that grid.", question: "Why is the Feature card grid (web/cursor/demo/demo.html:34) built with CSS grid instead of flexbox?" };
  const inputJson = JSON.stringify(input);

  function toolEvents(json: string, chunk = 5): Ev[] {
    const evs: Ev[] = [{ type: "message_start", message: {} }, toolStart];
    for (let i = 0; i < json.length; i += chunk) evs.push(jsonDelta(0, json.slice(i, i + chunk)));
    evs.push({ type: "content_block_stop", index: 0 }, { type: "message_stop" });
    return evs;
  }

  it("forced mode: request shape follows ARCHITECTURE §4", async () => {
    const final = { stop_reason: "tool_use", content: [{ type: "tool_use", name: "ask_opus", input }], usage: usage() };
    const { client, messagesStream, betaStream } = mockClient({ messages: [fakeStream(toolEvents(inputJson), final)] });
    setClient(client);
    await routeWithHaiku({ mark: recorder().mark, transcript: U3, pointing: GRID_TARGETS, mode: "forced", onSpokenDelta: () => {} });

    expect(betaStream).not.toHaveBeenCalled();
    const p = messagesStream.mock.calls[0]![0] as Record<string, any>;
    expect(p.model).toBe("claude-haiku-5-5");
    expect(p.output_config).toEqual({ effort: "low" });
    expect(p.tool_choice).toMatchObject({ type: "tool", name: "ask_opus" });
    for (const k of ["temperature", "top_p", "top_k", "thinking", "fallbacks", "betas", "speed"]) expect(p).not.toHaveProperty(k);
    expect(p.tools).toEqual([ROUTER_TOOL]);
    expect(p.tools[0].eager_input_streaming).toBe(true);
    expect(Object.keys(p.tools[0].input_schema.properties)).toEqual(["ack", "question"]);
    expect(p.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(p.messages[0].content).toContain(U3);
    expect(p.messages[0].content).toContain("[data-source=web/cursor/demo/demo.html:34]");
  });

  it("forced mode: streams the ack while JSON arrives, then returns the question", async () => {
    const final = { stop_reason: "tool_use", content: [{ type: "tool_use", name: "ask_opus", input }], usage: usage({ cache_read_input_tokens: 600 }) };
    const { client } = mockClient({ messages: [fakeStream(toolEvents(inputJson, 3), final)] });
    setClient(client);
    const r = recorder();
    const spoken: string[] = [];
    const kinds = new Set<string>();
    const events: string[] = [];
    const res = await routeWithHaiku({
      mark: r.mark, transcript: U3, pointing: GRID_TARGETS, mode: "forced",
      onSpokenDelta: (d, kind) => { spoken.push(d); kinds.add(kind); events.push("delta"); },
      onSpokenEnd: (kind) => events.push(`end:${kind}`),
    });

    expect([...kinds]).toEqual(["ack"]);
    expect(events.filter((e) => e.startsWith("end"))).toEqual(["end:ack"]);
    expect(events[events.length - 1]).toBe("end:ack");
    expect(spoken.length).toBeGreaterThan(3); // incremental, not one burst
    expect(spoken.join("")).toBe(input.ack);
    expect(res.delegate).toEqual({ question: input.question });
    expect(res.usage).toEqual(final.usage);
    expect(r.names()).toEqual(["llm.request", "llm.toolCall", "llm.firstToken"]);
    expect(logs.some((l) => l.includes("cache_read=600"))).toBe(true);
  });

  it("auto mode: a direct text answer is spoken and nothing is delegated", async () => {
    const evs: Ev[] = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      textDelta(1, "Yes, "), textDelta(1, "I can hear you."),
    ];
    const final = { stop_reason: "end_turn", content: [{ type: "text", text: "Yes, I can hear you." }], usage: usage() };
    const { client, messagesStream } = mockClient({ messages: [fakeStream(evs, final)] });
    setClient(client);
    const r = recorder();
    const spoken: string[] = [];
    const kinds: string[] = [];
    const res = await routeWithHaiku({ mark: r.mark, transcript: "Can you hear me?", pointing: [], mode: "auto", onSpokenDelta: (d, k) => { spoken.push(d); kinds.push(k); } });
    expect(spoken).toEqual(["Yes, ", "I can hear you."]);
    expect(kinds).toEqual(["answer", "answer"]);
    expect(res.delegate).toBeNull();
    expect(r.names()).toEqual(["llm.request", "llm.firstToken"]);
    expect((messagesStream.mock.calls[0]![0] as any).tool_choice).toMatchObject({ type: "auto" });
  });

  it("auto mode: text preamble plus a tool call speaks both and delegates", async () => {
    const evs: Ev[] = [textDelta(0, "Hmm. "), { ...toolStart, index: 1 }, jsonDelta(1, inputJson)];
    const final = { stop_reason: "tool_use", content: [], usage: usage() };
    const { client } = mockClient({ messages: [fakeStream(evs, final)] });
    setClient(client);
    const spoken: string[] = [];
    const res = await routeWithHaiku({ mark: recorder().mark, transcript: U3, pointing: GRID_TARGETS, mode: "auto", onSpokenDelta: (d) => spoken.push(d) });
    expect(spoken.join("")).toBe("Hmm. " + input.ack);
    expect(res.delegate?.question).toBe(input.question);
  });

  it("invalid / truncated tool input: delegates the raw transcript instead", async () => {
    const truncated = inputJson.slice(0, 50); // cut off mid-question
    const final = { stop_reason: "max_tokens", content: [], usage: usage() };
    const { client } = mockClient({ messages: [fakeStream(toolEvents(truncated), final)] });
    setClient(client);
    const res = await routeWithHaiku({ mark: recorder().mark, transcript: U3, pointing: GRID_TARGETS, mode: "forced", onSpokenDelta: () => {} });
    expect(res.delegate?.question).toContain(U3);
    expect(res.delegate?.question).toContain("demo.html:34");
    expect(logs.some((l) => l.includes("input invalid"))).toBe(true);
  });

  it("schema-invalid input (missing question) is rejected", async () => {
    const final = { stop_reason: "tool_use", content: [], usage: usage() };
    const { client } = mockClient({ messages: [fakeStream(toolEvents(`{"ack":"ok"}`), final)] });
    setClient(client);
    const res = await routeWithHaiku({ mark: recorder().mark, transcript: U3, pointing: [], mode: "forced", onSpokenDelta: () => {} });
    expect(res.delegate?.question).toContain(U3);
  });

  it("refusal: throws (no fallback for Haiku)", async () => {
    const final = { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null }, content: [], usage: usage() };
    const { client } = mockClient({ messages: [fakeStream([], final)] });
    setClient(client);
    await expect(routeWithHaiku({ mark: recorder().mark, transcript: U3, pointing: [], mode: "forced", onSpokenDelta: () => {} }))
      .rejects.toBeInstanceOf(ClaudeRefusalError);
  });

  it("API errors propagate", async () => {
    const err = new Anthropic.AuthenticationError(401, undefined, "bad key", new Headers());
    const { client } = mockClient({ messages: [fakeStream([], {}, err)] });
    setClient(client);
    await expect(routeWithHaiku({ mark: recorder().mark, transcript: U3, pointing: [], mode: "forced", onSpokenDelta: () => {} })).rejects.toBe(err);
  });
});

// ── solveWithOpus ──────────────────────────────────────────────────────────

describe("solveWithOpus", () => {
  const answer = "SPOKEN: The cards need to line up in rows and columns, and grid does that in one rule. Flexbox stretched the last row.\n\n## Details\nSee D1 in DECISIONS.md (`demo.css` `.card-grid`).";
  function opusEvents(text: string, chunk = 7): Ev[] {
    const evs: Ev[] = [
      { type: "message_start", message: {} },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    ];
    for (let i = 0; i < text.length; i += chunk) evs.push(textDelta(1, text.slice(i, i + chunk)));
    return evs;
  }
  const finalOk = (o: Record<string, unknown> = {}) => ({ model: "claude-opus-5-5", stop_reason: "end_turn", stop_details: null, content: [], usage: usage(), ...o });

  it("request shape: beta endpoint, effort medium, refusal fallback, cached fixture context", async () => {
    const { client, betaStream, messagesStream } = mockClient({ beta: [fakeStream(opusEvents(answer), finalOk())] });
    setClient(client);
    await solveWithOpus({ mark: recorder().mark, question: U3, pointing: GRID_TARGETS, fast: false, onSpokenLine: () => {}, onDelta: () => {} });
    expect(messagesStream).not.toHaveBeenCalled();
    const [p, reqOpts] = betaStream.mock.calls[0]! as [Record<string, any>, unknown];
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.output_config).toEqual({ effort: "medium" });
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    for (const k of ["thinking", "tool_choice", "tools", "speed", "temperature"]) expect(p).not.toHaveProperty(k);
    expect(p.system).toHaveLength(2);
    expect(p.system[0].cache_control).toBeUndefined();
    expect(p.system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(p.system[1].text).toContain("grid-template-columns: repeat(auto-fill, minmax(240px, 1fr))");
    expect(p.system[1].text).toContain("## D1. Feature cards use CSS grid");
    expect(p.messages[0].content).toContain(U3);
    expect(p.messages[0].content).toContain("[data-source=web/cursor/demo/demo.html:34]");
    expect(reqOpts).toBeUndefined();
  });

  it("system blocks are byte-identical across calls (cache prefix stability)", async () => {
    const { client, betaStream } = mockClient({ beta: [fakeStream(opusEvents(answer), finalOk()), fakeStream(opusEvents(answer), finalOk())] });
    setClient(client);
    const go = (q: string) => solveWithOpus({ mark: recorder().mark, question: q, pointing: [], fast: false, onSpokenLine: () => {}, onDelta: () => {} });
    await go("a");
    await go("b");
    const sys = betaStream.mock.calls.map((c) => JSON.stringify((c[0] as any).system));
    expect(sys[0]).toBe(sys[1]);
  });

  it("fast mode: speed fast + fast beta, no SDK retries", async () => {
    const { client, betaStream } = mockClient({ beta: [fakeStream(opusEvents(answer), finalOk({ usage: usage({ speed: "fast" }) }))] });
    setClient(client);
    const r = recorder();
    await solveWithOpus({ mark: r.mark, question: U3, pointing: GRID_TARGETS, fast: true, onSpokenLine: () => {}, onDelta: () => {} });
    const [p, reqOpts] = betaStream.mock.calls[0]! as [Record<string, any>, unknown];
    expect(p.speed).toBe("fast");
    expect(p.betas).toEqual(["fast-mode-2026-02-01", "server-side-fallback-2026-07-01"]);
    expect(p.fallbacks).toBe("default");
    expect(reqOpts).toEqual({ maxRetries: 0 });
    expect(r.marks.find((m) => m.name === "opus.done")?.meta).toMatchObject({ speed: "fast" });
  });

  it("streams deltas, fires the SPOKEN line once, emits marks in order", async () => {
    const { client } = mockClient({ beta: [fakeStream(opusEvents(answer, 4), finalOk({ usage: usage({ cache_read_input_tokens: 4321 }) }))] });
    setClient(client);
    const r = recorder();
    const deltas: string[] = [];
    const lines: string[] = [];
    const res = await solveWithOpus({
      mark: r.mark, question: U3, pointing: GRID_TARGETS, fast: false,
      onSpokenLine: (l) => { lines.push(l); r.mark("turn.end", { probe: deltas.join("").length }); },
      onDelta: (d) => deltas.push(d),
    });
    expect(deltas.join("")).toBe(answer);
    expect(res.text).toBe(answer);
    expect(lines).toEqual(["The cards need to line up in rows and columns, and grid does that in one rule. Flexbox stretched the last row."]);
    // spoken line fired as soon as the newline streamed in, well before the end
    const probe = r.marks.find((m) => m.name === "turn.end")!.meta!.probe as number;
    expect(probe).toBeLessThan(answer.indexOf("\n") + 5);
    expect(r.names()).toEqual(["opus.request", "opus.firstToken", "opus.spokenReady", "turn.end", "opus.done"]);
    expect(r.marks.at(-1)!.meta).toMatchObject({ stopReason: "end_turn", cacheReadInputTokens: 4321 });
    expect(logs.some((l) => l.includes("opus") && l.includes("cache_read=4321"))).toBe(true);
  });

  it("missing SPOKEN prefix falls back to the first sentence", async () => {
    const text = "Grid lines the cards up on shared column tracks across every row. Flexbox can't do that.\n\nMore.";
    const { client } = mockClient({ beta: [fakeStream(opusEvents(text), finalOk())] });
    setClient(client);
    const r = recorder();
    const lines: string[] = [];
    await solveWithOpus({ mark: r.mark, question: U3, pointing: [], fast: false, onSpokenLine: (l) => lines.push(l), onDelta: () => {} });
    expect(lines).toEqual(["Grid lines the cards up on shared column tracks across every row."]);
    expect(r.marks.find((m) => m.name === "opus.spokenReady")?.meta).toEqual({ viaPrefix: false });
  });

  it("fast mode 429 before any output falls back to standard speed", async () => {
    const rl = new Anthropic.RateLimitError(429, undefined, "fast mode rate limited", new Headers());
    const { client, betaStream } = mockClient({ beta: [fakeStream([], {}, rl), fakeStream(opusEvents(answer), finalOk())] });
    setClient(client);
    const r = recorder();
    const res = await solveWithOpus({ mark: r.mark, question: U3, pointing: [], fast: true, onSpokenLine: () => {}, onDelta: () => {} });
    expect(res.text).toBe(answer);
    expect(betaStream).toHaveBeenCalledTimes(2);
    const second = betaStream.mock.calls[1]![0] as Record<string, any>;
    expect(second).not.toHaveProperty("speed");
    expect(second.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(r.names().filter((n) => n === "opus.request")).toHaveLength(2);
    expect(r.marks.at(-1)!.meta).toMatchObject({ fastFallback: true });
  });

  it("429 in standard mode is not swallowed", async () => {
    const rl = new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers());
    const { client } = mockClient({ beta: [fakeStream([], {}, rl)] });
    setClient(client);
    await expect(solveWithOpus({ mark: recorder().mark, question: U3, pointing: [], fast: false, onSpokenLine: () => {}, onDelta: () => {} })).rejects.toBe(rl);
  });

  it("records a server-side refusal fallback hop", async () => {
    const evs: Ev[] = [
      { type: "content_block_start", index: 0, content_block: { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } } },
      ...opusEvents(answer).slice(1),
    ];
    const { client } = mockClient({ beta: [fakeStream(evs, finalOk({ model: "claude-opus-4-8" }))] });
    setClient(client);
    const r = recorder();
    await solveWithOpus({ mark: r.mark, question: U3, pointing: [], fast: false, onSpokenLine: () => {}, onDelta: () => {} });
    expect(r.marks.at(-1)!.meta).toMatchObject({ refusalFallbacks: [{ from: "claude-opus-5-5", to: "claude-opus-4-8" }] });
  });

  it("refusal after the fallback chain: throws", async () => {
    const final = finalOk({ stop_reason: "refusal", stop_details: { type: "refusal", category: "bio", explanation: "x" } });
    const { client } = mockClient({ beta: [fakeStream([], final)] });
    setClient(client);
    const err = await solveWithOpus({ mark: recorder().mark, question: U3, pointing: [], fast: false, onSpokenLine: () => {}, onDelta: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeRefusalError);
    expect((err as ClaudeRefusalError).category).toBe("bio");
  });

  it("stream that ends without a newline still emits the spoken line", async () => {
    const { client } = mockClient({ beta: [fakeStream(opusEvents("SPOKEN: Short and done."), finalOk())] });
    setClient(client);
    const lines: string[] = [];
    await solveWithOpus({ mark: recorder().mark, question: U3, pointing: [], fast: false, onSpokenLine: (l) => lines.push(l), onDelta: () => {} });
    expect(lines).toEqual(["Short and done."]);
  });
});

describe("fixture context", () => {
  it("includes every fixture file with stable paths and line numbers", () => {
    const ctx = loadFixtureContext();
    for (const p of ["web/cursor/demo/demo.html", "web/cursor/demo/demo.css", "web/cursor/demo/demo.ts", "DECISIONS.md", "notes/claude-code-session-2026-03-18.md"]) {
      expect(ctx).toContain(`<file path="${p}"`);
    }
    expect(ctx).toMatch(/ 34\| {7}<div class="card-grid" data-source="web\/cursor\/demo\/demo.html:34"/);
    expect(loadFixtureContext()).toBe(ctx);
  });
});
