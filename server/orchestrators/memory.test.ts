// Chat mode (RunConfig.memory): conversation history across turns and approaches.
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type RunConfig } from "../../shared/config.ts";
import { ConnectionState } from "../connection.ts";
import { getConversation, formatHistoryRecap, type ChatTurn } from "../conversation.ts";
import { historyMessages } from "../adapters/claude.ts";
import type { RouteWithHaikuOpts, SolveWithOpusOpts } from "../adapters/types.ts";
import { createFakeDeps, DEFAULT_SCENARIO, FAST_TIMING } from "./fakes.ts";
import { createPipelineOrchestrator } from "./pipeline.ts";
import { createRealtimeOrchestrator } from "./realtime.ts";
import type { Orchestrator, TurnContext, TurnResult } from "./types.ts";

const FRAME = Buffer.alloc(960);
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
  it("pipeline (B) sends the earlier turns to Haiku and Opus", async () => {
    const conn = new ConnectionState();
    getConversation(conn).push(B_TURN);
    const d = createFakeDeps(FAST_TIMING, DEFAULT_SCENARIO);
    const seen: { haiku?: RouteWithHaikuOpts["history"]; opus?: SolveWithOpusOpts["history"] } = {};
    const route = d.routeWithHaiku, solve = d.solveWithOpus;
    d.routeWithHaiku = (o) => { seen.haiku = o.history; return route(o); };
    d.solveWithOpus = (o) => { seen.opus = o.history; return solve(o); };
    await runTurn(createPipelineOrchestrator(d), ctx("t2", { approach: "pipeline" }, conn));
    expect(seen.haiku).toEqual([B_TURN]);
    expect(seen.opus).toEqual([B_TURN]);
  });

  it("pipeline without memory sends no history", async () => {
    const conn = new ConnectionState();
    getConversation(conn).push(B_TURN);
    const d = createFakeDeps(FAST_TIMING, DEFAULT_SCENARIO);
    let history: unknown = "unset";
    const route = d.routeWithHaiku;
    d.routeWithHaiku = (o) => { history = o.history; return route(o); };
    await runTurn(createPipelineOrchestrator(d), ctx("t2", { approach: "pipeline", memory: false }, conn));
    expect(history).toBeUndefined();
  });

  it("realtime (A) gets a recap of turns it didn't hear, once, and transcribes via Scribe", async () => {
    const conn = new ConnectionState();
    getConversation(conn).push(B_TURN);
    const d = createFakeDeps(FAST_TIMING, { ...DEFAULT_SCENARIO, delegate: false });
    const orch = createRealtimeOrchestrator(d);
    const r1 = await runTurn(orch, ctx("a1", { approach: "realtime" }, conn));
    expect(d.log.contexts[0]).toContain("User: What is this card?");
    expect(d.log.contexts[0]).toContain("Assistant: That's the Embeds card.");
    expect(r1.transcript).not.toBe(""); // chat mode: A runs Scribe for the transcript
    getConversation(conn).push({ turnId: "a1", approach: "realtime", user: r1.transcript, assistant: r1.voiceText, detail: "" });
    await runTurn(orch, ctx("a2", { approach: "realtime" }, conn));
    expect(d.log.contexts[1]).toBeUndefined(); // same session heard a1 itself and already got b1
  });

  it("realtime without memory: no Scribe, no recap", async () => {
    const conn = new ConnectionState();
    getConversation(conn).push(B_TURN);
    const d = createFakeDeps(FAST_TIMING, { ...DEFAULT_SCENARIO, delegate: false });
    const r = await runTurn(createRealtimeOrchestrator(d), ctx("a1", { approach: "realtime", memory: false }, conn));
    expect(d.log.contexts[0]).toBeUndefined();
    expect(r.transcript).toBe("");
    expect(d.log.opened.some((id) => /scribe/i.test(id))).toBe(false);
  });

  it("history messages alternate user/assistant; Opus gets its detailed answer back", () => {
    const empty: ChatTurn = { turnId: "x", approach: "realtime", user: "", assistant: "Sure.", detail: "" };
    expect(historyMessages([B_TURN, empty], false)).toEqual([
      { role: "user", content: "What is this card?" }, { role: "assistant", content: "That's the Embeds card." },
      { role: "user", content: "(inaudible)" }, { role: "assistant", content: "Sure." },
    ]);
    expect(historyMessages([B_TURN, empty], true)[1]!.content).toBe(B_TURN.detail);
    expect(historyMessages([B_TURN, empty], true)[3]!.content).toBe("SPOKEN: Sure.");
    expect(formatHistoryRecap([])).toBe("");
  });
});
