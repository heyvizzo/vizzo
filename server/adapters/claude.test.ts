import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CursorSample, PointingTarget } from "../../shared/protocol.ts";
import type { MarkName } from "../../shared/marks.ts";
import {
  ClaudeRefusalError, DEFAULT_LONG_TASK_SECONDS, type ClaudeClient, formatPointingForPrompt, generateFillers, loadFixtureContext,
  routeWithHaiku, routerTool, setClient, setLogger, solveWithOpus, validateRouterInput,
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

function mockClient(opts: { messages?: FakeStream[]; beta?: FakeStream[]; create?: unknown[] }) {
  const messagesStream = vi.fn((_params: unknown, _o?: unknown) => {
    const s = opts.messages?.shift();
    if (!s) throw new Error("unexpected messages.stream call");
    return s;
  });
  /** messages.create: each queued item resolves, or rejects if it's an Error. */
  const messagesCreate = vi.fn(async (_params: unknown, _o?: unknown) => {
    if (!opts.create?.length) throw new Error("unexpected messages.create call");
    const r = opts.create.shift();
    if (r instanceof Error) throw r;
    return r;
  });
  const betaStream = vi.fn((_params: unknown, _o?: unknown) => {
    const s = opts.beta?.shift();
    if (!s) throw new Error("unexpected beta.messages.stream call");
    return s;
  });
  const client = { messages: { stream: messagesStream, create: messagesCreate }, beta: { messages: { stream: betaStream } } } as unknown as ClaudeClient;
  return { client, messagesStream, messagesCreate, betaStream };
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
  const toolStart: Ev = { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "route", input: {} } };
  const Q_INPUT = {
    intent: "question", estimate_seconds: 12, say: "Let me check that card grid.",
    question: "Why is the Feature card grid (web/cursor/demo/demo.html:34) built with CSS grid instead of flexbox?",
  };

  function toolEvents(json: string, chunk = 5): Ev[] {
    const evs: Ev[] = [{ type: "message_start", message: {} }, toolStart];
    for (let i = 0; i < json.length; i += chunk) evs.push(jsonDelta(0, json.slice(i, i + chunk)));
    evs.push({ type: "content_block_stop", index: 0 }, { type: "message_stop" });
    return evs;
  }
  const finalFor = (input: unknown, o: Record<string, unknown> = {}) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "route", input }], usage: usage(), ...o });

  /** Runs the router on a streamed JSON string and records every callback in order. */
  async function run(json: string, opts: { mode?: "forced" | "auto"; transcript?: string; pointing?: PointingTarget[]; chunk?: number; final?: Record<string, unknown> } = {}) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(json); } catch { /* truncated */ }
    const { client, messagesStream } = mockClient({ messages: [fakeStream(toolEvents(json, opts.chunk ?? 4), opts.final ?? finalFor(parsed))] });
    setClient(client);
    const r = recorder();
    const events: string[] = [];
    const spoken: string[] = [];
    const decisions: unknown[] = [];
    const res = await routeWithHaiku({
      mark: r.mark, transcript: opts.transcript ?? U3, pointing: opts.pointing ?? GRID_TARGETS, mode: opts.mode ?? "forced",
      onDecision: (d) => { decisions.push(d); events.push(`decision:${d.intent}`); },
      onSpokenDelta: (d, kind) => { spoken.push(d); events.push(`say:${kind}`); },
      onSpokenEnd: (kind) => events.push(`end:${kind}`),
    });
    return { res, r, events, spoken, said: spoken.join(""), decisions, params: messagesStream.mock.calls[0]![0] as Record<string, any> };
  }

  it("request shape: one forced `route` tool in both modes, §4 settings, cached system prompt", async () => {
    for (const mode of ["forced", "auto"] as const) {
      const { params: p } = await run(JSON.stringify(Q_INPUT), { mode });
      expect(p.model).toBe("claude-haiku-5-5");
      expect(p.output_config).toEqual({ effort: "low" });
      expect(p.tool_choice).toEqual({ type: "tool", name: "route", disable_parallel_tool_use: true });
      for (const k of ["temperature", "top_p", "top_k", "thinking", "fallbacks", "betas", "speed"]) expect(p).not.toHaveProperty(k);
      expect(p.tools).toEqual([routerTool(mode)]);
      expect(p.tools[0].eager_input_streaming).toBe(true);
      expect(Object.keys(p.tools[0].input_schema.properties)).toEqual(["intent", "estimate_seconds", "say", "question"]);
      expect(p.tools[0].input_schema.properties.intent.enum).toEqual(
        mode === "forced" ? ["question", "task", "clarify"] : ["question", "task", "clarify", "answer"],
      );
      expect(p.system[0].cache_control).toEqual({ type: "ephemeral" });
      expect(p.system[0].text).toContain(`${DEFAULT_LONG_TASK_SECONDS} seconds`);
      expect(p.system[0].text).not.toContain("{{");
      expect(p.messages.at(-1).content).toContain(U3);
      expect(p.messages.at(-1).content).toContain("[data-source=web/cursor/demo/demo.html:34]");
      expect(p.messages.at(-1).content).toMatch(mode === "forced" ? /Never answer yourself/ : /You may use answer/);
    }
  });

  it("question: decision fires before any say delta, say streams as ack, returns the delegate", async () => {
    const { res, r, events, spoken, said, decisions } = await run(JSON.stringify(Q_INPUT), { chunk: 3 });
    expect(decisions).toEqual([{ intent: "question", estimateS: 12 }]);
    expect(events[0]).toBe("decision:question");
    expect(events.filter((e) => e.startsWith("say:")).every((e) => e === "say:ack")).toBe(true);
    expect(events.at(-1)).toBe("end:ack");
    expect(events.filter((e) => e.startsWith("end:"))).toHaveLength(1);
    expect(spoken.length).toBeGreaterThan(3); // incremental, not one burst
    expect(said).toBe(Q_INPUT.say);
    expect(res.delegate).toEqual({ question: Q_INPUT.question, intent: "question", estimateS: 12 });
    expect(res.decision).toEqual({ intent: "question", estimateS: 12 });
    expect(r.names()).toEqual(["llm.request", "llm.toolCall", "llm.firstToken"]);
  });

  it("onSpokenEnd fires at say's closing quote, before the question streams", async () => {
    const json = JSON.stringify(Q_INPUT);
    let fed = 0;
    const evs = toolEvents(json, 1);
    const stream: FakeStream = {
      async *[Symbol.asyncIterator]() {
        for (const e of evs) {
          await Promise.resolve();
          if ((e.delta as { type?: string } | undefined)?.type === "input_json_delta") fed++;
          yield e;
        }
      },
      finalMessage: () => Promise.resolve(finalFor(Q_INPUT)),
    };
    const { client } = mockClient({ messages: [stream] });
    setClient(client);
    let fedAtEnd = -1;
    await routeWithHaiku({ mark: () => {}, transcript: U3, pointing: GRID_TARGETS, mode: "forced", onSpokenDelta: () => {}, onSpokenEnd: () => { fedAtEnd = fed; } });
    expect(fedAtEnd).toBe(json.indexOf(`","question"`) + 1); // right at the closing quote
  });

  it("long task: decision carries the estimate; the 'take a while' line is spoken as ack", async () => {
    const input = {
      intent: "task", estimate_seconds: 120, say: "On it. That'll take a couple of minutes, I'll let you know when it's done.",
      question: "Make the Get started button (web/cursor/demo/demo.html:20) bigger.",
    };
    const { res, events, said, decisions } = await run(JSON.stringify(input));
    expect(decisions).toEqual([{ intent: "task", estimateS: 120 }]);
    expect(events[0]).toBe("decision:task");
    expect(said).toBe(input.say);
    expect(events.at(-1)).toBe("end:ack");
    expect(res.delegate).toEqual({ question: input.question, intent: "task", estimateS: 120 });
  });

  it("clarify: no delegate, say is the whole reply (kind answer)", async () => {
    const input = { intent: "clarify", say: "Which part do you want changed?" };
    const { res, events, said, decisions } = await run(JSON.stringify(input), { transcript: "Change it", pointing: [] });
    expect(decisions).toEqual([{ intent: "clarify", estimateS: null }]);
    expect(events[0]).toBe("decision:clarify");
    expect(events.slice(1, -1).every((e) => e === "say:answer")).toBe(true);
    expect(events.at(-1)).toBe("end:answer");
    expect(said).toBe(input.say);
    expect(res).toMatchObject({ delegate: null, decision: { intent: "clarify", estimateS: null } });
  });

  it("clarify ignores a stray estimate", async () => {
    const { res, decisions } = await run(JSON.stringify({ intent: "clarify", estimate_seconds: 30, say: "Which one?" }));
    expect(decisions).toEqual([{ intent: "clarify", estimateS: null }]);
    expect(res.decision.estimateS).toBeNull();
  });

  it("auto mode: answer is spoken as the whole reply, nothing delegated", async () => {
    const { res, events, said } = await run(JSON.stringify({ intent: "answer", say: "Yes, I can hear you." }), { mode: "auto", transcript: "Can you hear me?", pointing: [] });
    expect(said).toBe("Yes, I can hear you.");
    expect(events).toEqual(expect.arrayContaining(["decision:answer", "end:answer"]));
    expect(events[0]).toBe("decision:answer");
    expect(res).toMatchObject({ delegate: null, decision: { intent: "answer", estimateS: null } });
  });

  it("forced mode: `answer` is not allowed; with a transcript it degrades to delegating", async () => {
    const { res } = await run(JSON.stringify({ intent: "answer", say: "Sure." }), { mode: "forced" });
    expect(res.delegate?.question).toContain(U3);
    expect(res.decision.intent).toBe("question");
  });

  it("say before intent (model ignored the order): say is buffered until the decision", async () => {
    const json = `{"say":"Checking that grid now.","intent":"question","estimate_seconds":8,"question":"Why grid?"}`;
    const { res, events, said, decisions } = await run(json, { chunk: 3 });
    expect(events[0]).toBe("decision:question");
    expect(decisions).toEqual([{ intent: "question", estimateS: 8 }]);
    expect(said).toBe("Checking that grid now.");
    expect(events.filter((e) => e.startsWith("say:"))).toEqual(["say:ack"]); // released in one piece
    expect(res.delegate).toEqual({ question: "Why grid?", intent: "question", estimateS: 8 });
  });

  it("say before estimate: say is held until its end, then the decision fires (estimate null); the return value has the late estimate", async () => {
    const json = `{"intent":"task","say":"Give me a couple of minutes.","estimate_seconds":90,"question":"Make it bigger."}`;
    const { res, events, decisions } = await run(json, { chunk: 2 });
    expect(decisions).toEqual([{ intent: "task", estimateS: null }]);
    expect(events).toEqual(["decision:task", "say:ack", "end:ack"]);
    expect(res.decision).toEqual({ intent: "task", estimateS: 90 });
    expect(logs.some((l) => l.includes("differs from final"))).toBe(true);
  });

  it("no intent at all: buffered say is released at the end, intent inferred from the question", async () => {
    const json = `{"say":"One sec.","question":"Why grid?"}`;
    const { res, events, said } = await run(json);
    expect(events).toEqual(["decision:question", "say:ack", "end:ack"]);
    expect(said).toBe("One sec.");
    expect(res.decision).toEqual({ intent: "question", estimateS: null });
    expect(res.delegate?.question).toContain(U3); // input was invalid (no intent): raw transcript fallback
  });

  it("missing estimate: decision fires at the end of say with estimateS null", async () => {
    const json = `{"intent":"question","say":"Looking now.","question":"Why grid?"}`;
    const { res, events } = await run(json);
    expect(events[0]).toBe("decision:question");
    expect(res.decision).toEqual({ intent: "question", estimateS: null });
    expect(res.delegate).toEqual({ question: "Why grid?", intent: "question", estimateS: null });
  });

  it("non-eager fallback: no JSON deltas, the input comes only in finalMessage()", async () => {
    const evs: Ev[] = [{ type: "message_start", message: {} }, toolStart, { type: "content_block_stop", index: 0 }];
    const { client } = mockClient({ messages: [fakeStream(evs, finalFor(Q_INPUT))] });
    setClient(client);
    const events: string[] = [];
    const res = await routeWithHaiku({
      mark: () => {}, transcript: U3, pointing: GRID_TARGETS, mode: "forced",
      onDecision: (d) => events.push(`decision:${d.intent}:${d.estimateS}`),
      onSpokenDelta: (d, k) => events.push(`say:${k}:${d}`),
      onSpokenEnd: (k) => events.push(`end:${k}`),
    });
    expect(events).toEqual(["decision:question:12", `say:ack:${Q_INPUT.say}`, "end:ack"]);
    expect(res.delegate?.estimateS).toBe(12);
  });

  it("truncated input: delegates the raw transcript + pointing, keeping the announced decision", async () => {
    const truncated = JSON.stringify({ ...Q_INPUT, intent: "task", estimate_seconds: 90 }).slice(0, 90); // cut off mid-question
    const { res, decisions } = await run(truncated, { final: { stop_reason: "max_tokens", content: [], usage: usage() } });
    expect(decisions).toEqual([{ intent: "task", estimateS: 90 }]);
    expect(res.delegate?.question).toContain(U3);
    expect(res.delegate?.question).toContain("demo.html:34");
    expect(res.delegate).toMatchObject({ intent: "task", estimateS: 90 });
    expect(logs.some((l) => l.includes("input invalid"))).toBe(true);
  });

  it("schema-invalid input (question intent without a question): question fallback, estimate null", async () => {
    const { res, decisions } = await run(`{"intent":"question","say":"ok"}`, { pointing: [] });
    expect(decisions).toEqual([{ intent: "question", estimateS: null }]);
    expect(res.delegate).toEqual({ question: `${U3}\n${formatPointingForPrompt([])}`, intent: "question", estimateS: null });
    expect(res.decision).toEqual({ intent: "question", estimateS: null });
  });

  it("truncated after a complete clarify: keeps the clarify (it was already spoken)", async () => {
    const json = `{"intent":"clarify","say":"Which button do you mean?","question":"x`;
    const { res, said } = await run(json, { final: { stop_reason: "max_tokens", content: [], usage: usage() } });
    expect(said).toBe("Which button do you mean?");
    expect(res).toMatchObject({ delegate: null, decision: { intent: "clarify", estimateS: null } });
  });

  it("invalid input with an empty transcript: nothing to delegate", async () => {
    const { res, decisions } = await run(`{"say":"`, { transcript: "  ", pointing: [], final: { stop_reason: "max_tokens", content: [], usage: usage() } });
    expect(res.delegate).toBeNull();
    expect(decisions).toHaveLength(1);
  });

  it("history is threaded as prior messages (follow-up to a clarifying question)", async () => {
    const history = [{ turnId: "t1", approach: "pipeline" as const, user: "Make this button bigger", assistant: "Which button, the Get started one or Sign up?", detail: "" }];
    const { client, messagesStream } = mockClient({ messages: [fakeStream(toolEvents(JSON.stringify(Q_INPUT)), finalFor(Q_INPUT))] });
    setClient(client);
    await routeWithHaiku({ mark: () => {}, transcript: "the first one", pointing: [], mode: "forced", history, onSpokenDelta: () => {} });
    const msgs = (messagesStream.mock.calls[0]![0] as any).messages;
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1].content).toBe("Which button, the Get started one or Sign up?");
    expect(msgs[2].content).toContain('"the first one"');
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

  it("validateRouterInput", () => {
    expect(validateRouterInput({ intent: "task", estimate_seconds: "45", say: " ok ", question: " q " })).toEqual({ intent: "task", estimateS: 45, say: "ok", question: "q" });
    expect(validateRouterInput({ intent: "question", estimate_seconds: -3, say: "", question: "q" })?.estimateS).toBeNull();
    expect(validateRouterInput({ intent: "clarify", say: "" })).toBeNull();
    expect(validateRouterInput({ intent: "answer", say: "hi" }, "forced")).toBeNull();
    expect(validateRouterInput({ intent: "nope", say: "hi" })).toBeNull();
    expect(validateRouterInput(null)).toBeNull();
  });
});

// ── generateFillers ────────────────────────────────────────────────────────

describe("generateFillers", () => {
  const args = { transcript: U3, question: "Why is the grid a grid?", intent: "question" as const, pointing: GRID_TARGETS };

  it("forced non-streaming `progress` call, Haiku effort low, cached system prompt; trims and caps lines", async () => {
    const msg = {
      stop_reason: "tool_use", usage: usage(),
      content: [{ type: "tool_use", name: "progress", input: { lines: [" Opening the stylesheet for that grid. ", "", "Now checking the design notes.", "Looking at the card layout.", "Extra line."] } }],
    };
    const { client, messagesCreate } = mockClient({ create: [msg] });
    setClient(client);
    const res = await generateFillers(args);
    expect(res.lines).toEqual(["Opening the stylesheet for that grid.", "Now checking the design notes.", "Looking at the card layout."]);
    expect(res.usage).toEqual(msg.usage);
    const p = messagesCreate.mock.calls[0]![0] as Record<string, any>;
    expect(p.model).toBe("claude-haiku-5-5");
    expect(p.output_config).toEqual({ effort: "low" });
    expect(p).not.toHaveProperty("stream");
    expect(p.tool_choice).toEqual({ type: "tool", name: "progress", disable_parallel_tool_use: true });
    expect(p.tools[0].input_schema.properties.lines.type).toBe("array");
    expect(p.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(p.messages[0].content).toContain("Intent: question");
    expect(p.messages[0].content).toContain("demo.html:34");
  });

  it("task intent is passed through", async () => {
    const { client, messagesCreate } = mockClient({ create: [{ stop_reason: "tool_use", usage: usage(), content: [{ type: "tool_use", name: "progress", input: { lines: ["a b c d"] } }] }] });
    setClient(client);
    await generateFillers({ ...args, intent: "task" });
    expect((messagesCreate.mock.calls[0]![0] as any).messages[0].content).toContain("Intent: task");
  });

  it("API failure: empty lines, never throws, logs", async () => {
    const { client } = mockClient({ create: [new Anthropic.InternalServerError(500, undefined, "boom", new Headers())] });
    setClient(client);
    await expect(generateFillers(args)).resolves.toEqual({ lines: [], usage: null });
    expect(logs.some((l) => l.includes("fillers failed"))).toBe(true);
  });

  it("malformed tool input: empty lines", async () => {
    const { client } = mockClient({ create: [{ stop_reason: "tool_use", usage: usage(), content: [{ type: "tool_use", name: "progress", input: { lines: "nope" } }] }] });
    setClient(client);
    expect((await generateFillers(args)).lines).toEqual([]);
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

  it("task intent: the user message frames a change request; system blocks stay byte-identical", async () => {
    const { client, betaStream } = mockClient({ beta: [fakeStream(opusEvents(answer), finalOk()), fakeStream(opusEvents(answer), finalOk())] });
    setClient(client);
    const r = recorder();
    await solveWithOpus({ mark: r.mark, question: "Make the Get started button bigger.", pointing: GRID_TARGETS, fast: false, intent: "task", onSpokenLine: () => {}, onDelta: () => {} });
    await solveWithOpus({ mark: recorder().mark, question: U3, pointing: GRID_TARGETS, fast: false, onSpokenLine: () => {}, onDelta: () => {} });
    const [task, question] = betaStream.mock.calls.map((c) => c[0] as Record<string, any>);
    expect(task!.messages.at(-1).content).toMatch(/^Request type: TASK\. This is a change request/);
    expect(task!.messages.at(-1).content).toContain("Task: Make the Get started button bigger.");
    expect(task!.messages.at(-1).content).toContain("[data-source=web/cursor/demo/demo.html:34]");
    expect(question!.messages.at(-1).content).toMatch(/^Question: /);
    expect(question!.messages.at(-1).content).not.toContain("TASK");
    expect(JSON.stringify(task!.system)).toBe(JSON.stringify(question!.system));
    expect(task!.system[0].text).toContain("Request type: TASK");
    expect(r.marks.find((m) => m.name === "opus.request")?.meta).toMatchObject({ intent: "task" });
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
