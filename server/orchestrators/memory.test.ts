// Chat mode (RunConfig.memory): conversation history across turns.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type RunConfig } from "../../shared/config.ts";
import { ConnectionState } from "../connection.ts";
import { getConversation, resetConversation, type ChatTurn } from "../conversation.ts";
import { historyMessages } from "../adapters/claude.ts";
import type { RouteTurnOpts, SolveTaskOpts } from "../adapters/types.ts";
import { createFakeDeps, DEFAULT_SCENARIO, FAST_TIMING } from "./fakes.ts";
import { createPipelineOrchestrator } from "./pipeline.ts";
import type { Orchestrator, TurnContext, TurnResult } from "./types.ts";

const FRAME = Buffer.alloc(960);
// The conversation is process-level now: start every test from an empty one.
beforeEach(() => resetConversation());
const B_TURN: ChatTurn = { turnId: "b1", approach: "pipeline", user: "What is this card?", assistant: "That's the Embeds card.", detail: "SPOKEN: That's the Embeds card.\n\nDetails…" };

function ctx(turnId: string, config: Partial<RunConfig>, connection: ConnectionState): TurnContext {
  return {
    turnId, config: { ...DEFAULT_CONFIG, memory: true, ...config }, mark: () => {}, send: () => {}, sendAudio: () => {},
    cursorSamples: () => [], tAudioStart: () => 1000, connection,
  };
}

async function runTurn(orch: Orchestrator, c: TurnContext): Promise<TurnResult> {
  const h = orch(c);
  for (let i = 0; i < 25; i++) h.onAudio(FRAME);
  await new Promise((r) => setTimeout(r, 5));
  h.onRelease();
  return h.done;
}

describe("chat memory", () => {
  it("the router gets the earlier turns; the solver's conversation session is told them once, then only what's new", async () => {
    const conn = new ConnectionState();
    getConversation(conn).push(B_TURN);
    const d = createFakeDeps(FAST_TIMING, DEFAULT_SCENARIO);
    const seen: { router?: RouteTurnOpts["history"] } = {};
    const route = d.routeTurn;
    d.routeTurn = (o) => { seen.router = o.history; return route(o); };
    const orch = createPipelineOrchestrator(d);
    const r1 = await runTurn(orch, ctx("t2", { approach: "pipeline" }, conn));
    expect(seen.router).toEqual([B_TURN]);
    // A new session: the conversation so far as text, every answer whole.
    expect(d.log.threadSends).toHaveLength(1);
    expect(d.log.threadSends[0]!.replay).toMatch(/^Conversation so far \(oldest first\):/);
    expect(d.log.threadSends[0]!.replay).toContain(`User: ${B_TURN.user}\n\nAssistant: ${B_TURN.detail}`);

    // The turn it answered is in its own history; a note from elsewhere (a thread finishing) is what it hears next.
    getConversation(conn).push({ turnId: "t2", approach: "pipeline", user: r1.transcript, assistant: r1.voiceText, detail: r1.solverText });
    getConversation(conn).push({ turnId: "th1:2", approach: "pipeline", user: "(Task update)", assistant: "The red button is done.", detail: "SPOKEN: The red button is done." });
    await runTurn(orch, ctx("t3", { approach: "pipeline" }, conn));
    expect(d.log.threadSends).toHaveLength(2);
    expect(d.log.threadSends[1]!.threadId).toBe(d.log.threadSends[0]!.threadId);
    expect(d.log.threadSends[1]!.replay).toBe("");
    expect(d.log.threadSends[1]!.notes).toMatch(/^Since your last reply in this conversation/);
    expect(d.log.threadSends[1]!.notes).toContain("(Task update)");
    expect(d.log.threadSends[1]!.notes).not.toContain(B_TURN.user);
    expect(d.log.threadSends[1]!.notes).not.toContain(r1.transcript);
  });

  it("New conversation closes the conversation's session; the next turn opens another", async () => {
    const conn = new ConnectionState();
    const d = createFakeDeps(FAST_TIMING, DEFAULT_SCENARIO);
    const orch = createPipelineOrchestrator(d);
    await runTurn(orch, ctx("t1", { approach: "pipeline" }, conn));
    const first = d.log.threadSends[0]!.threadId;
    resetConversation();
    expect(d.log.threadClosed).toEqual([first]);
    await runTurn(orch, ctx("t2", { approach: "pipeline" }, conn));
    expect(d.log.threadSends[1]!.threadId).not.toBe(first);
  });

  it("the conversation's session keeps the model it was opened with when the smart tier changes", async () => {
    const conn = new ConnectionState();
    const d = createFakeDeps(FAST_TIMING, DEFAULT_SCENARIO);
    const opened: string[] = [];
    const open = d.openThread!;
    d.openThread = (o) => { opened.push(o.choice.model); return open(o); };
    const orch = createPipelineOrchestrator(d);
    await runTurn(orch, ctx("t1", { approach: "pipeline" }, conn));
    const other = { ...DEFAULT_CONFIG.llm, smart: { provider: "codex" as const, model: "gpt-6.1-sol" } };
    await runTurn(orch, ctx("t2", { approach: "pipeline", llm: other }, conn));
    expect(opened).toEqual([DEFAULT_CONFIG.llm.smart.model]);
    expect(d.log.threadSends.map((x) => x.threadId)).toEqual(["thread#1", "thread#1"]);
  });

  it("without thread sessions (no openThread) the solver is one request with the history", async () => {
    const conn = new ConnectionState();
    getConversation(conn).push(B_TURN);
    const d = createFakeDeps(FAST_TIMING, DEFAULT_SCENARIO);
    delete d.openThread;
    let history: SolveTaskOpts["history"];
    const solve = d.solveTask;
    d.solveTask = (o) => { history = o.history; return solve(o); };
    await runTurn(createPipelineOrchestrator(d), ctx("t2", { approach: "pipeline" }, conn));
    expect(history).toEqual([B_TURN]);
  });

  it("pipeline without memory sends no history", async () => {
    const conn = new ConnectionState();
    getConversation(conn).push(B_TURN);
    const d = createFakeDeps(FAST_TIMING, DEFAULT_SCENARIO);
    let history: unknown = "unset";
    const route = d.routeTurn;
    d.routeTurn = (o) => { history = o.history; return route(o); };
    await runTurn(createPipelineOrchestrator(d), ctx("t2", { approach: "pipeline", memory: false }, conn));
    expect(history).toBeUndefined();
  });

  it("history messages alternate user/assistant; the solver gets its detailed answer back", () => {
    const empty: ChatTurn = { turnId: "x", approach: "pipeline", user: "", assistant: "Sure.", detail: "" };
    expect(historyMessages([B_TURN, empty], false)).toEqual([
      { role: "user", content: "What is this card?" }, { role: "assistant", content: "That's the Embeds card." },
      { role: "user", content: "(inaudible)" }, { role: "assistant", content: "Sure." },
    ]);
    expect(historyMessages([B_TURN, empty], true)[1]!.content).toBe(B_TURN.detail);
    expect(historyMessages([B_TURN, empty], true)[3]!.content).toBe("SPOKEN: Sure.");
  });

  it("an earlier answer goes back to the solver whole, however long", () => {
    const long: ChatTurn = { ...B_TURN, detail: `SPOKEN: Long.\n\n${"x".repeat(6000)} END` };
    expect(historyMessages([long], true)[1]!.content).toBe(long.detail);
  });
});

describe("router/the solver per-turn context", () => {
  it("page context and a non-default long-task threshold go into the user message, not the cached system prompt", async () => {
    const { buildRouterParams, buildSolverParams } = await import("../adapters/claude.ts");
    const page = 'Clicked: <th> "Price / month" in "Pricing table" [data-source=web/cursor/demo/demo.html:63]';
    const p = buildRouterParams("what is this", [], "forced", [], { pageContext: page, longTaskSeconds: 45 });
    const last = p.messages[p.messages.length - 1]!.content as string;
    expect(last).toContain(page);
    expect(last).toContain("45 seconds");
    const d = buildRouterParams("what is this", [], "forced", [], { longTaskSeconds: 20 });
    expect(d.messages[0]!.content as string).not.toContain("threshold");
    const o = buildSolverParams("q", [], [], "question", page);
    expect(o.messages[o.messages.length - 1]!.content as string).toContain(page);
  });
});

describe("harnessPromptInfo", () => {
  it("shows the role's system prompt, the turn flattened into one message, and how the harness runs", async () => {
    const { buildRouterParams, harnessPromptInfo } = await import("../adapters/claude.ts");
    const params = buildRouterParams("what is this", [], "forced", [B_TURN], { pageContext: "Clicked: <th> \"Price\"" });
    const p = harnessPromptInfo("router", { provider: "codex", model: "gpt-6-luna", level: "low" }, params);
    expect(p.model).toBe("gpt-6-luna via Codex");
    expect(p.system).toEqual([{ label: "router.md + JSON output format", text: expect.stringContaining("intent") }]);
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]!.text).toMatch(/^Conversation so far/);
    expect(p.messages[0]!.text).toContain("Clicked:");
    expect(p.settings).toMatchObject({ harness: "Codex", level: "low", run: expect.stringContaining("codex app-server") });
  });
});


describe("history that doesn't fit", () => {
  it("whole turns are kept, newest first, and the text says how many older ones were left out", async () => {
    const { conversationText, fitHistory } = await import("../conversation.ts");
    const turns: ChatTurn[] = Array.from({ length: 5 }, (_, i) => ({ turnId: `t${i}`, approach: "pipeline", user: `q${i}`, assistant: "", detail: `SPOKEN: a${i}\n\n${"x".repeat(100)}` }));
    const { kept, omitted } = fitHistory(turns, 500);
    expect(omitted).toBe(2);
    expect(kept.map((t) => t.turnId)).toEqual(["t2", "t3", "t4"]);
    expect(kept.every((t) => t.detail.endsWith("x".repeat(100)))).toBe(true);
    // The latest turn always goes, even alone over the budget.
    expect(fitHistory(turns, 10).kept.map((t) => t.turnId)).toEqual(["t4"]);
    vi.stubEnv("VIZZO_REPLAY_MAX_CHARS", "500");
    const text = conversationText(turns, "Conversation so far (oldest first):");
    vi.unstubAllEnvs();
    expect(text).toMatch(/^Conversation so far \(oldest first\):\n\n\(2 earlier turns left out/);
    expect(text).not.toContain("q1");
    expect(text).toContain("User: q2\n\nAssistant: SPOKEN: a2");
  });
});

describe("cost of a conversation turn", () => {
  it("is priced with the model the conversation's session runs on, not the one Settings names now", async () => {
    const { costItems } = await import("../cost.ts");
    const usage = { anthropic: { solver: { input_tokens: 100, output_tokens: 10 } } };
    const now = { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, smart: { provider: "codex" as const, model: "gpt-6.1-sol" } } };
    expect(costItems(now, usage).find((c) => c.label.startsWith("Solver"))!.label).toMatch(/gpt-6.1-sol \(Codex/);
    const ran = costItems(now, { ...usage, solverLlm: DEFAULT_CONFIG.llm.smart });
    expect(ran.find((c) => c.label.startsWith("Solver"))!.label).toMatch(/claude-opus-5-5 \(Claude Code · subscription\)/);
  });
});
