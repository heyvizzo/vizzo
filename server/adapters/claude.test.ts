import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CursorSample, PointingTarget } from "../../shared/protocol.ts";
import type { MarkName } from "../../shared/marks.ts";
import type { LlmChoice } from "../../shared/config.ts";
import {
  ClaudeRefusalError, DEFAULT_LONG_TASK_SECONDS, flattenMessages, extractJsonObject, formatPointingForPrompt, generateFillers,
  routeTurn, setLogger, solveInThread, solveTask, threadUserMessage, validateRouterInput,
} from "./claude.ts";
import type { HarnessThread, ThreadBrief } from "./types.ts";
import type { AgentSpec, HarnessResult, WarmAgent } from "./harnesses.ts";
import { setAgentFactory, stopWarm } from "./warmPool.ts";
import { setProjectDir } from "../project.ts";

// A small project folder for these tests (the real one is PROJECT_DIR; the tests don't depend on it).
const PROJECT = mkdtempSync(join(tmpdir(), "claude-test-project-"));
beforeAll(() => {
  writeFileSync(join(PROJECT, "demo.html"), '<div class="card-grid" data-source="demo.html:34">');
  setProjectDir(PROJECT);
});
afterAll(() => setProjectDir(null));

// ── Fake harness agents ─────────────────────────────────────────────────────
// Each request streams the next scripted reply in small chunks (or fails), and records what it was sent.

interface Script { text?: string; chunk?: number; result?: Partial<HarnessResult>; fail?: Error; failAfter?: number }
let scripts: Script[] = [];
let sent: { spec: AgentSpec; user: string }[] = [];

class FakeAgent implements WarmAgent {
  private used = false;
  constructor(private spec: AgentSpec) {}
  alive(): boolean { return !this.used; }
  ready(): boolean { return true; }
  async request(user: string, onText: ((d: string) => void) | undefined): Promise<HarnessResult> {
    this.used = true;
    sent.push({ spec: this.spec, user });
    const s = scripts.shift();
    if (!s) throw new Error("unexpected request");
    if (s.fail && s.failAfter === undefined) throw s.fail;
    const text = s.text ?? "";
    const n = s.chunk ?? 4;
    for (let i = 0; i < text.length; i += n) {
      if (s.failAfter !== undefined && i >= s.failAfter) throw s.fail;
      await Promise.resolve();
      onText?.(text.slice(i, i + n));
    }
    return { text, stopReason: "end_turn", model: this.spec.model, usage: { input_tokens: 100, output_tokens: 20 }, raw: null, warm: true, ...s.result };
  }
  kill(): void {}
}

function recorder() {
  const marks: { name: MarkName; meta?: Record<string, unknown> }[] = [];
  return { marks, mark: (name: MarkName, meta?: Record<string, unknown>) => { marks.push({ name, meta }); }, names: () => marks.map((m) => m.name) };
}

const sample = (o: Partial<CursorSample>): CursorSample => ({
  t: 1000, x: 10, y: 10, scrollX: 0, scrollY: 0, elementPath: null, dataSource: null, label: null, ...o,
});
const GRID_TARGETS: PointingTarget[] = [
  { word: "this", wordStart: 0.42, algorithm: "atStart", sample: sample({ elementPath: "body > main > section#features > h2", label: "Features heading", dataSource: "demo.html:33" }) },
  { word: "this", wordStart: 0.42, algorithm: "dwellMode", sample: sample({ elementPath: "body > main > section#features > div.card-grid", label: "Feature card grid", dataSource: "demo.html:34" }) },
];
const U3 = "Why is this section built with a grid instead of flexbox?";

let logs: string[] = [];
beforeEach(() => { logs = []; scripts = []; sent = []; setLogger((m) => logs.push(m)); setAgentFactory((s) => new FakeAgent(s)); });
afterEach(() => { stopWarm(); setAgentFactory(null); setLogger((m) => console.info(m)); });

// ── formatPointingForPrompt ────────────────────────────────────────────────

describe("formatPointingForPrompt", () => {
  it("adds each pointed element's CSS selector when asked", () => {
    expect(formatPointingForPrompt(GRID_TARGETS, { selectors: true })).toBe(
      `Pointing: "this" → <div> "Feature card grid" [data-source=demo.html:34]\n   selector: body > main > section#features > div.card-grid`,
    );
  });

  it("prefers dwellMode and formats tag, label and data-source", () => {
    expect(formatPointingForPrompt(GRID_TARGETS)).toBe(`Pointing: "this" → <div> "Feature card grid" [data-source=demo.html:34]`);
  });
  it("one line per word, in spoken order; strips punctuation; handles unresolved", () => {
    const t: PointingTarget[] = [
      { word: "there.", wordStart: 1.2, algorithm: "dwell", sample: null },
      { word: "this", wordStart: 0.3, algorithm: "dwell", sample: sample({ elementPath: "article.card", label: "Card: Alerts", dataSource: null }) },
    ];
    expect(formatPointingForPrompt(t)).toBe(`Pointing: "this" → <article> "Card: Alerts"\nPointing: "there" → (nothing)`);
  });
  it("says so when there is nothing", () => {
    expect(formatPointingForPrompt([])).toMatch(/^Pointing: none/);
  });
});

// ── routeTurn ─────────────────────────────────────────────────────────

describe("routeTurn", () => {
  const Q_INPUT = {
    intent: "question", estimate_seconds: 12, say: "Let me check that card grid.",
    question: "Why is the Feature card grid (demo.html:34) built with CSS grid instead of flexbox?",
  };

  /** Runs the router on a streamed JSON reply and records every callback in order. */
  async function run(json: string, opts: { mode?: "forced" | "auto"; transcript?: string; pointing?: PointingTarget[]; chunk?: number; result?: Partial<HarnessResult>; llm?: LlmChoice } = {}) {
    scripts.push({ text: json, chunk: opts.chunk ?? 4, ...(opts.result ? { result: opts.result } : {}) });
    const r = recorder();
    const events: string[] = [];
    const spoken: string[] = [];
    const decisions: unknown[] = [];
    const res = await routeTurn({
      mark: r.mark, transcript: opts.transcript ?? U3, pointing: opts.pointing ?? GRID_TARGETS, mode: opts.mode ?? "forced", llm: opts.llm,
      onDecision: (d) => { decisions.push(d); events.push(`decision:${d.intent}`); },
      onSpokenDelta: (d, kind) => { spoken.push(d); events.push(`say:${kind}`); },
      onSpokenEnd: (kind) => events.push(`end:${kind}`),
    });
    return { res, r, events, spoken, said: spoken.join(""), decisions, sent: sent.at(-1)! };
  }

  it("request: the role's system prompt (JSON format, long-task threshold), the tier's choice, the turn in one message", async () => {
    for (const mode of ["forced", "auto"] as const) {
      const { sent: s } = await run(JSON.stringify(Q_INPUT), { mode, llm: { provider: "codex", model: "gpt-6-luna", level: "low" } });
      expect(s.spec).toMatchObject({ role: "router", harness: "codex", model: "gpt-6-luna", level: "low" });
      expect(s.spec.project).toBeUndefined();
      expect(s.spec.system).toContain("Reply with ONLY one JSON object");
      expect(s.spec.system).toContain(`${DEFAULT_LONG_TASK_SECONDS} seconds`);
      expect(s.spec.system).not.toContain("{{");
      expect(s.user).toContain(U3);
      expect(s.user).toContain("[data-source=demo.html:34]");
      expect(s.user).toMatch(mode === "forced" ? /Never answer yourself/ : /You may use answer/);
    }
  });

  it("no choice given: Claude Code with Haiku", async () => {
    const { sent: s } = await run(JSON.stringify(Q_INPUT));
    expect(s.spec).toMatchObject({ harness: "claude-code", model: "claude-haiku-5-5", level: "low" });
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
    expect(r.names()).toEqual(["llm.request", "llm.firstToken", "llm.toolCall"]);
  });

  it("a code fence before the JSON is skipped", async () => {
    const { res, said } = await run("```json\n" + JSON.stringify(Q_INPUT) + "\n```");
    expect(said).toBe(Q_INPUT.say);
    expect(res.delegate?.question).toBe(Q_INPUT.question);
  });

  it("long task: decision carries the estimate; the 'take a while' line is spoken as ack", async () => {
    const input = {
      intent: "task", estimate_seconds: 120, say: "On it. That'll take a couple of minutes, I'll let you know when it's done.",
      question: "Make the Get started button (demo.html:20) bigger.",
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

  it("truncated input: delegates the raw transcript + pointing, keeping the announced decision", async () => {
    const truncated = JSON.stringify({ ...Q_INPUT, intent: "task", estimate_seconds: 90 }).slice(0, 90); // cut off mid-question
    const { res, decisions } = await run(truncated, { result: { stopReason: "max_tokens" } });
    expect(decisions).toEqual([{ intent: "task", estimateS: 90 }]);
    expect(res.delegate?.question).toContain(U3);
    expect(res.delegate?.question).toContain("demo.html:34");
    expect(res.delegate).toMatchObject({ intent: "task", estimateS: 90 });
    expect(logs.some((l) => l.includes("output invalid"))).toBe(true);
  });

  it("schema-invalid input (question intent without a question): question fallback, estimate null", async () => {
    const { res, decisions } = await run(`{"intent":"question","say":"ok"}`, { pointing: [] });
    expect(decisions).toEqual([{ intent: "question", estimateS: null }]);
    expect(res.delegate).toEqual({ question: `${U3}\n${formatPointingForPrompt([])}`, intent: "question", estimateS: null });
    expect(res.decision).toEqual({ intent: "question", estimateS: null });
  });

  it("truncated after a complete clarify: keeps the clarify (it was already spoken)", async () => {
    const json = `{"intent":"clarify","say":"Which button do you mean?","question":"x`;
    const { res, said } = await run(json, { result: { stopReason: "max_tokens" } });
    expect(said).toBe("Which button do you mean?");
    expect(res).toMatchObject({ delegate: null, decision: { intent: "clarify", estimateS: null } });
  });

  it("invalid input with an empty transcript: nothing to delegate", async () => {
    const { res, decisions } = await run(`{"say":"`, { transcript: "  ", pointing: [], result: { stopReason: "max_tokens" } });
    expect(res.delegate).toBeNull();
    expect(decisions).toHaveLength(1);
  });

  it("history is flattened into the one message (follow-up to a clarifying question)", async () => {
    const history = [{ turnId: "t1", approach: "pipeline" as const, user: "Make this button bigger", assistant: "Which button, the Get started one or Sign up?", detail: "" }];
    scripts.push({ text: JSON.stringify(Q_INPUT) });
    await routeTurn({ mark: () => {}, transcript: "the first one", pointing: [], mode: "forced", history, onSpokenDelta: () => {} });
    expect(sent[0]!.user).toMatch(/^Conversation so far \(oldest first\):\n\nUser: Make this button bigger\n\nAssistant: Which button, the Get started one or Sign up\?\n\n---\n\nThis turn:\n/);
    expect(sent[0]!.user).toContain('"the first one"');
  });

  it("a harness failure before any JSON propagates", async () => {
    const err = new Error("codex app-server exited");
    scripts.push({ fail: err });
    await expect(routeTurn({ mark: recorder().mark, transcript: U3, pointing: [], mode: "forced", onSpokenDelta: () => {} })).rejects.toBe(err);
  });

  it("a failure mid-stream degrades with what streamed (the announced decision stays)", async () => {
    scripts.push({ text: JSON.stringify({ ...Q_INPUT, intent: "task", estimate_seconds: 90 }), fail: new Error("timed out"), failAfter: 60 });
    const decisions: unknown[] = [];
    const res = await routeTurn({ mark: () => {}, transcript: U3, pointing: GRID_TARGETS, mode: "forced", onDecision: (d) => decisions.push(d), onSpokenDelta: () => {} });
    expect(decisions).toEqual([{ intent: "task", estimateS: 90 }]);
    expect(res.delegate).toMatchObject({ intent: "task", estimateS: 90 });
    expect(res.delegate?.question).toContain(U3);
  });

  it("refusal: throws", async () => {
    scripts.push({ text: "", result: { stopReason: "refusal" } });
    await expect(routeTurn({ mark: recorder().mark, transcript: U3, pointing: [], mode: "forced", onSpokenDelta: () => {} }))
      .rejects.toBeInstanceOf(ClaudeRefusalError);
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

describe("routeTurn, threads mode", () => {
  const BRIEFS: ThreadBrief[] = [
    { threadId: "t1", title: "the 'Get started' button", state: "running", summary: "Making it bigger with rounder corners.", onCurrentPage: true, underCursor: true },
    { threadId: "t2", title: "the footer", state: "pending", summary: "Lighter grey links.", onCurrentPage: false, underCursor: false },
  ];
  async function runT(fields: Record<string, unknown>, o: { threads?: ThreadBrief[]; anchorLabel?: string; mode?: "forced" | "auto"; raw?: string } = {}) {
    scripts.push({ text: o.raw ?? JSON.stringify(fields), chunk: 3 });
    const events: string[] = [];
    const decisions: unknown[] = [];
    const res = await routeTurn({
      mark: () => {}, transcript: "Also change the label to Start free.", pointing: GRID_TARGETS, mode: o.mode ?? "auto",
      threads: o.threads ?? BRIEFS, anchorLabel: "anchorLabel" in o ? o.anchorLabel : "the 'Get started' button",
      onDecision: (d) => { decisions.push(d); events.push("decision"); },
      onSpokenDelta: () => events.push("say"),
      onSpokenEnd: () => events.push("end"),
    });
    return { res, events, decisions, sent: sent.at(-1)! };
  }

  it("the system prompt is unchanged; the turn's message carries the rules, the pointed element, the threads and the format", async () => {
    const { sent: s } = await runT({ intent: "task", estimate_seconds: 60, target: "t1", relation: "followup", tell: null, say: "Sure.", question: "q" });
    expect(s.spec.system).not.toMatch(/thread/i);
    expect(s.user).toContain("What the user SAYS wins over the cursor");
    expect(s.user).toContain("Pointed element this turn: the 'Get started' button.");
    expect(s.user).toContain("- t1: the 'Get started' button (running, under the cursor): Making it bigger with rounder corners.");
    expect(s.user).toContain("- t2: the footer (pending, on another page): Lighter grey links.");
    expect(s.user).toContain(`"target": "new" | "<thread id>" | "central", "relation"`);
    expect(s.user).not.toContain("<!--");
    // Without threads: nothing of it.
    scripts.push({ text: JSON.stringify({ intent: "clarify", say: "Which one?" }) });
    await routeTurn({ mark: () => {}, transcript: U3, pointing: GRID_TARGETS, mode: "auto", onSpokenDelta: () => {} });
    expect(sent.at(-1)!.user).not.toMatch(/thread/i);
    expect(sent.at(-1)!.spec.system).toBe(s.spec.system);
  });

  it("empty thread list still means threads mode", async () => {
    const { sent: s, res } = await runT({ intent: "task", estimate_seconds: 60, target: "new", relation: null, tell: null, say: "Sure.", question: "q" }, { threads: [] });
    expect(s.user).toContain("Threads: none yet.");
    expect(res.decision.target).toEqual({ kind: "new" });
  });

  it("followup/correction to a thread: the decision fires once, before say, and matches the result", async () => {
    const { res, events, decisions } = await runT({
      intent: "task", estimate_seconds: 60, target: "t1", relation: "correction", tell: null, say: "Okay, I'll switch it to Start free instead.", question: "Change the label to Start free.",
    });
    const want = { intent: "task", estimateS: 60, target: { kind: "thread", threadId: "t1", relation: "correction" } };
    expect(decisions).toEqual([want]);
    expect(events[0]).toBe("decision");
    expect(events.filter((e) => e === "decision")).toHaveLength(1);
    expect(res.decision).toEqual(want);
    expect(res.delegate).toEqual({ question: "Change the label to Start free.", intent: "task", estimateS: 60 });
  });

  it("unknown id: new when pointing, central when not", async () => {
    const f = { intent: "question", estimate_seconds: 8, target: "t7", relation: "followup", tell: null, say: "Let me check.", question: "q" };
    expect((await runT(f)).res.decision.target).toEqual({ kind: "new" });
    expect((await runT(f, { anchorLabel: undefined })).res.decision.target).toEqual({ kind: "central" });
  });

  it("tell: an answer with an empty say, nothing delegated, even in delegate mode", async () => {
    const { res, events } = await runT(
      { intent: "answer", estimate_seconds: null, target: "t2", relation: null, tell: "t2", say: "", question: "" }, { mode: "forced" },
    );
    expect(res.delegate).toBeNull();
    expect(res.decision).toEqual({ intent: "answer", estimateS: null, target: { kind: "thread", threadId: "t2", relation: "followup" }, tell: "t2" });
    expect(events).toEqual(["decision", "end"]);
  });

  it("delegate mode: an answer without tell becomes clarify", async () => {
    const { res } = await runT({ intent: "answer", estimate_seconds: null, target: "t1", relation: "followup", tell: null, say: "It's still working on it." }, { mode: "forced" });
    expect(res.decision).toMatchObject({ intent: "clarify", target: { kind: "thread", threadId: "t1" } });
    expect(res.delegate).toBeNull();
  });

  it("truncated after a tell: keeps it", async () => {
    const { res } = await runT({}, { raw: `{"intent":"answer","estimate_seconds":null,"target":"t2","relation":null,"tell":"t2","say":"` });
    expect(res.decision.tell).toBe("t2");
    expect(res.delegate).toBeNull();
  });

  it("invalid output: delegates the raw transcript, keeping the target", async () => {
    const { res } = await runT({}, { raw: `{"intent":"task","estimate_seconds":60,"target":"t1","relation":"followup","tell":null,"say":"Sure` });
    expect(res.decision).toEqual({ intent: "task", estimateS: 60, target: { kind: "thread", threadId: "t1", relation: "followup" } });
    expect(res.delegate?.question).toContain("Start free");
  });
});

// ── solveInThread ──────────────────────────────────────────────────────────

class FakeThread implements HarnessThread {
  readonly id = "hthread-test";
  readonly live = true;
  sentMsgs: string[] = [];
  constructor(private reply: string, private filesTouched: string[] = [], readonly choice?: LlmChoice) {}
  async send(user: string, onText: ((d: string) => void) | undefined) {
    this.sentMsgs.push(user);
    for (let i = 0; i < this.reply.length; i += 5) { await Promise.resolve(); onText?.(this.reply.slice(i, i + 5)); }
    return {
      text: this.reply, stopReason: "end_turn", model: "claude-opus-5-5", usage: { input_tokens: 5, output_tokens: 9 }, raw: null, warm: true,
      filesTouched: this.filesTouched, reopened: false,
    };
  }
  abort(): void {}
  close(): void {}
}

describe("solveInThread", () => {
  const answer = "SPOKEN: I changed the label to Start free.\n\n```diff\n- Get started\n+ Start free\n```";

  it("sends through the thread (no history), streams, fires the SPOKEN line, returns filesTouched", async () => {
    const thread = new FakeThread(answer, ["demo.html"], { provider: "claude-code", model: "claude-opus-5-5" });
    const r = recorder();
    const lines: string[] = [];
    const deltas: string[] = [];
    const prompts: unknown[] = [];
    const responses: unknown[] = [];
    const res = await solveInThread({
      thread, kind: "request", mark: r.mark, question: "Make the button bigger.", pointing: GRID_TARGETS, intent: "task",
      onSpokenLine: (l) => lines.push(l), onDelta: (d) => deltas.push(d), onPrompt: (p) => prompts.push(p), onResponse: (x) => responses.push(x),
    });
    expect(sent).toHaveLength(0); // never the warm pool
    expect(thread.sentMsgs).toHaveLength(1);
    expect(thread.sentMsgs[0]).toMatch(/^Request type: TASK/);
    expect(thread.sentMsgs[0]).toContain("selector: body > main > section#features > div.card-grid");
    expect(res).toEqual({ text: answer, usage: { input_tokens: 5, output_tokens: 9 }, filesTouched: ["demo.html"] });
    expect(deltas.join("")).toBe(answer);
    expect(lines).toEqual(["I changed the label to Start free."]);
    expect(r.names()).toEqual(["solver.request", "solver.firstToken", "solver.spokenReady", "solver.done"]);
    expect(r.marks[0]!.meta).toMatchObject({ thread: "hthread-test", kind: "request", intent: "task", backend: "claude-code" });
    expect(prompts[0]).toMatchObject({ target: "solver", messages: [{ role: "user", text: thread.sentMsgs[0] }], settings: { thread: "hthread-test" } });
    expect(responses[0]).toMatchObject({ target: "solver", raw: { filesTouched: ["demo.html"], reopened: false } });
  });

  it("an unknown or other harness: narration is dropped up to the SPOKEN line", async () => {
    const thread = new FakeThread("Let me look at the CSS first. " + answer);
    const lines: string[] = [];
    const res = await solveInThread({
      thread, kind: "followup", mark: () => {}, question: "Also round the corners.", pointing: [], intent: "task",
      onSpokenLine: (l) => lines.push(l), onDelta: () => {},
    });
    expect(res.text.trim()).toBe(answer);
    expect(lines).toEqual(["I changed the label to Start free."]);
  });

  it("frames follow-ups, corrections and reconcile notes", () => {
    const f = threadUserMessage("followup", "Also round the corners.", [], "task");
    expect(f).toMatch(/^Follow-up on the same element/);
    expect(f).toContain("Task: Also round the corners.");
    expect(f).not.toContain("Pointing");
    expect(threadUserMessage("followup", "Why blue?", GRID_TARGETS, "question", undefined, "ro")).toMatch(/Question: Why blue\?[\s\S]*Pointing context[\s\S]*Romanian/);
    const c = threadUserMessage("correction", "Make it green instead.", [], "task");
    expect(c).toContain("changed their mind");
    expect(c).toContain("replaces their previous instruction: Make it green instead.");
    expect(c).toContain("final state match");
    const n = threadUserMessage("reconcile", "demo.css was also changed by another task meanwhile: re-read it.", GRID_TARGETS);
    expect(n).toMatch(/^System note \(not from the user\): demo\.css/);
    expect(n).toContain("SPOKEN line first");
  });

  it("thread errors propagate (and are reported)", async () => {
    const thread = new FakeThread(answer);
    thread.send = async () => { throw Object.assign(new Error("stopped"), { name: "AbortError" }); };
    const responses: { error?: string }[] = [];
    await expect(solveInThread({
      thread, kind: "request", mark: () => {}, question: "q", pointing: [], onSpokenLine: () => {}, onDelta: () => {}, onResponse: (x) => responses.push(x),
    })).rejects.toThrow("stopped");
    expect(responses[0]!.error).toBe("stopped");
  });
});

describe("generateFillers", () => {
  const args = { transcript: U3, question: "Why is the grid a grid?", intent: "question" as const, pointing: GRID_TARGETS };

  it("parses the JSON lines; trims, drops empty ones and caps at three", async () => {
    scripts.push({ text: JSON.stringify({ lines: [" Opening the stylesheet for that grid. ", "", "Now checking the design notes.", "Looking at the card layout.", "Extra line."] }) });
    const res = await generateFillers(args);
    expect(res.lines).toEqual(["Opening the stylesheet for that grid.", "Now checking the design notes.", "Looking at the card layout."]);
    expect(sent[0]!.spec).toMatchObject({ role: "fillers", harness: "claude-code" });
    expect(sent[0]!.spec.system).toContain('{"lines"');
    expect(sent[0]!.user).toContain("Intent: question");
    expect(sent[0]!.user).toContain("demo.html:34");
  });

  it("task intent is passed through", async () => {
    scripts.push({ text: '{"lines":["a b c d"]}' });
    await generateFillers({ ...args, intent: "task" });
    expect(sent[0]!.user).toContain("Intent: task");
  });

  it("harness failure: empty lines, never throws, logs", async () => {
    scripts.push({ fail: new Error("boom") });
    await expect(generateFillers(args)).resolves.toEqual({ lines: [], usage: null });
    expect(logs.some((l) => l.includes("progress lines failed"))).toBe(true);
  });

  it("malformed output: empty lines", async () => {
    scripts.push({ text: '{"lines": "nope"}' });
    expect((await generateFillers(args)).lines).toEqual([]);
  });
});

// ── solveTask ──────────────────────────────────────────────────────────

describe("solveTask", () => {
  const answer = "SPOKEN: The cards need to line up in rows and columns, and grid does that in one rule. Flexbox stretched the last row.\n\n## Details\nSee D1 in DECISIONS.md (`demo.css` `.card-grid`).";
  const solve = (o: { llm?: LlmChoice; lines?: string[]; deltas?: string[]; mark?: (n: MarkName, m?: Record<string, unknown>) => void } = {}) =>
    solveTask({
      mark: o.mark ?? (() => {}), question: U3, pointing: GRID_TARGETS, fast: false, llm: o.llm,
      onSpokenLine: (l) => o.lines?.push(l), onDelta: (d) => o.deltas?.push(d),
    });

  it("streams deltas, fires the SPOKEN line once, emits marks in order", async () => {
    scripts.push({ text: answer, result: { usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 4321 } } });
    const r = recorder();
    const deltas: string[] = [];
    const lines: string[] = [];
    const res = await solveTask({
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
    expect(r.names()).toEqual(["solver.request", "solver.firstToken", "solver.spokenReady", "turn.end", "solver.done"]);
    expect(r.marks.at(-1)!.meta).toMatchObject({ stopReason: "end_turn", cacheReadInputTokens: 4321 });
    expect(logs.some((l) => l.includes("solver") && l.includes("cache_read=4321"))).toBe(true);
  });

  it("works in the project folder; Claude Code gets its own tool names in the note", async () => {
    scripts.push({ text: answer });
    await solve();
    expect(sent[0]!.spec).toMatchObject({ role: "solver", harness: "claude-code", model: "claude-opus-5-5", project: PROJECT });
    expect(sent[0]!.spec.system).toContain("with Glob, Grep and Read");
    scripts.push({ text: answer });
    await solve({ llm: { provider: "omp", model: "anthropic/claude-opus-5-5", level: "high", speed: "fast" } });
    expect(sent[1]!.spec).toMatchObject({ harness: "omp", level: "high", speed: "fast", project: PROJECT });
    expect(sent[1]!.spec.system).toContain("with your file search and read tools");
  });

  it("another harness's narration before its tools is dropped up to the SPOKEN line", async () => {
    scripts.push({ text: "I'll check the grid's CSS and the decisions file." + answer });
    const deltas: string[] = [];
    const lines: string[] = [];
    const res = await solve({ llm: { provider: "codex", model: "gpt-6.1-sol" }, deltas, lines });
    expect(res.text).toBe(answer);
    expect(lines[0]).toMatch(/^The cards need to line up/);
  });

  it("missing SPOKEN prefix falls back to the first sentence", async () => {
    scripts.push({ text: "Grid lines the cards up on shared column tracks across every row. Flexbox can't do that.\n\nMore." });
    const r = recorder();
    const lines: string[] = [];
    await solve({ mark: r.mark, lines });
    expect(lines).toEqual(["Grid lines the cards up on shared column tracks across every row."]);
    expect(r.marks.find((m) => m.name === "solver.spokenReady")?.meta).toEqual({ viaPrefix: false });
  });

  it("harness errors propagate", async () => {
    const err = new Error("pi (solver) exited");
    scripts.push({ fail: err });
    await expect(solve()).rejects.toBe(err);
  });

  it("refusal: throws", async () => {
    scripts.push({ text: "", result: { stopReason: "refusal" } });
    await expect(solve()).rejects.toBeInstanceOf(ClaudeRefusalError);
  });

  it("stream that ends without a newline still emits the spoken line", async () => {
    scripts.push({ text: "SPOKEN: Short and done." });
    const lines: string[] = [];
    await solve({ lines });
    expect(lines).toEqual(["Short and done."]);
  });

  it("without a project folder: no folder, no project note", async () => {
    setProjectDir(null);
    try {
      scripts.push({ text: answer });
      await solve();
      expect(sent[0]!.spec.project).toBeUndefined();
      expect(sent[0]!.spec.system).not.toContain("Your working directory is the project");
    } finally {
      setProjectDir(PROJECT);
    }
  });
});

describe("request shaping", () => {
  it("flattens earlier turns into one user message; extracts the JSON object from fenced text", () => {
    const msg = flattenMessages({ messages: [
      { role: "user", content: "What is this?" }, { role: "assistant", content: "The pricing table." }, { role: "user", content: "Transcript: \"and that?\"" },
    ] });
    expect(msg).toBe('Conversation so far (oldest first):\n\nUser: What is this?\n\nAssistant: The pricing table.\n\n---\n\nThis turn:\nTranscript: "and that?"');
    expect(flattenMessages({ messages: [{ role: "user", content: "only" }] })).toBe("only");
    expect(extractJsonObject('```json\n{"intent":"clarify","say":"Which one?"}\n```')).toBe('{"intent":"clarify","say":"Which one?"}');
    expect(extractJsonObject("no json")).toBeNull();
  });
});
