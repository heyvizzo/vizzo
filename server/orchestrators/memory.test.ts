// Chat mode (RunConfig.memory): conversation history across turns.
import { beforeEach, describe, expect, it } from "vitest";
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
  it("pipeline sends the earlier turns to the router and the solver", async () => {
    const conn = new ConnectionState();
    getConversation(conn).push(B_TURN);
    const d = createFakeDeps(FAST_TIMING, DEFAULT_SCENARIO);
    const seen: { router?: RouteTurnOpts["history"]; solver?: SolveTaskOpts["history"] } = {};
    const route = d.routeTurn, solve = d.solveTask;
    d.routeTurn = (o) => { seen.router = o.history; return route(o); };
    d.solveTask = (o) => { seen.solver = o.history; return solve(o); };
    await runTurn(createPipelineOrchestrator(d), ctx("t2", { approach: "pipeline" }, conn));
    expect(seen.router).toEqual([B_TURN]);
    expect(seen.solver).toEqual([B_TURN]);
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

