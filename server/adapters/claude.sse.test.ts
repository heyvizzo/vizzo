// Runs the adapter through the REAL @anthropic-ai/sdk client against a local fake HTTP server
// that speaks the Messages SSE wire format. Verifies what the SDK actually sends (body + beta
// header + retries) and that its stream events/finalMessage() are consumed correctly.
// No network access to Anthropic is involved.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarkName } from "../../shared/marks.ts";
import { routeWithHaiku, setClient, setLogger, solveWithOpus } from "./claude.ts";

interface Captured { body: Record<string, any>; headers: IncomingMessage["headers"] }
type Responder = (req: Captured, res: ServerResponse) => void;

let server: Server;
let baseURL = "";
const captured: Captured[] = [];
const queue: Responder[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const cap = { body: JSON.parse(raw) as Record<string, any>, headers: req.headers };
      captured.push(cap);
      const next = queue.shift();
      if (!next) { res.writeHead(500).end("no responder"); return; }
      next(cap, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  setLogger(() => {});
});
afterAll(() => { server.close(); setClient(null); setLogger((m) => console.info(m)); });
afterEach(() => { captured.length = 0; queue.length = 0; });

function sse(events: Record<string, unknown>[]): Responder {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const e of events) res.write(`event: ${e.type as string}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  };
}
const status = (code: number, type: string): Responder => (_req, res) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message: type } }));
};

const usage = { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const msgStart = (model: string, u: Record<string, unknown> = usage) => ({
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: u },
});
const msgEnd = (stop_reason: string, extraUsage: Record<string, unknown> = {}) => [
  { type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 40, ...extraUsage } },
  { type: "message_stop" },
];

const marks = () => {
  const list: MarkName[] = [];
  return { list, mark: (n: MarkName) => { list.push(n); } };
};

describe("adapter over the real SDK client (local SSE server)", () => {
  it("Haiku forced: eager tool JSON streams the ack; body has the §4 settings", async () => {
    setClient(new Anthropic({ apiKey: "test-key", baseURL }));
    const input = JSON.stringify({ ack: "Sure, checking the \"grid\" now.", question: "Why grid at demo.html:34?" });
    const deltas = [];
    for (let i = 0; i < input.length; i += 6) {
      deltas.push({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: input.slice(i, i + 6) } });
    }
    queue.push(sse([
      msgStart("claude-haiku-5-5"),
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "ask_opus", input: {} } },
      ...deltas,
      { type: "content_block_stop", index: 0 },
      ...msgEnd("tool_use"),
    ]));
    const m = marks();
    const spoken: string[] = [];
    const res = await routeWithHaiku({ mark: m.mark, transcript: "Why is this a grid?", pointing: [], mode: "forced", onSpokenDelta: (d) => spoken.push(d) });

    expect(spoken.join("")).toBe('Sure, checking the "grid" now.');
    expect(spoken.length).toBeGreaterThan(2);
    expect(res.delegate).toEqual({ question: "Why grid at demo.html:34?" });
    expect(m.list).toEqual(["llm.request", "llm.toolCall", "llm.firstToken"]);

    const { body, headers } = captured[0]!;
    expect(body.stream).toBe(true);
    expect(body.model).toBe("claude-haiku-5-5");
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body.tool_choice).toEqual({ type: "tool", name: "ask_opus", disable_parallel_tool_use: true });
    expect(body.tools[0].eager_input_streaming).toBe(true);
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("thinking");
    expect(headers["anthropic-beta"]).toBeUndefined();
  });

  it("Opus fast: speed + betas header; 429 falls back to standard without SDK retries", async () => {
    setClient(new Anthropic({ apiKey: "test-key", baseURL }));
    const text = "SPOKEN: Grid aligns both axes.\n\nDetails here.";
    queue.push(status(429, "rate_limit_error"));
    queue.push(sse([
      msgStart("claude-opus-5-5", { ...usage, cache_read_input_tokens: 3000 }),
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      ...[...text].map((c) => ({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: c } })),
      { type: "content_block_stop", index: 1 },
      ...msgEnd("end_turn"),
    ]));
    const m = marks();
    const lines: string[] = [];
    const res = await solveWithOpus({ mark: m.mark, question: "Why grid?", pointing: [], fast: true, onSpokenLine: (l) => lines.push(l), onDelta: () => {} });

    expect(captured).toHaveLength(2); // one fast attempt (no retries) + one standard
    const [fastReq, stdReq] = captured as [Captured, Captured];
    expect(fastReq.body.speed).toBe("fast");
    expect(fastReq.body.fallbacks).toBe("default");
    expect(fastReq.body.output_config).toEqual({ effort: "medium" });
    expect(fastReq.body).not.toHaveProperty("betas");
    expect(fastReq.body).not.toHaveProperty("thinking");
    expect(fastReq.headers["anthropic-beta"]).toBe("fast-mode-2026-02-01,server-side-fallback-2026-07-01");
    expect(stdReq.body).not.toHaveProperty("speed");
    expect(stdReq.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");

    expect(res.text).toBe(text);
    expect(lines).toEqual(["Grid aligns both axes."]);
    expect((res.usage as { cache_read_input_tokens: number }).cache_read_input_tokens).toBe(3000);
    expect(m.list).toEqual(["opus.request", "opus.request", "opus.firstToken", "opus.spokenReady", "opus.done"]);
  });

  it("Opus refusal stop_reason surfaces as an error", async () => {
    setClient(new Anthropic({ apiKey: "test-key", baseURL }));
    queue.push(sse([msgStart("claude-opus-5-5"), ...msgEnd("refusal")]));
    await expect(solveWithOpus({ mark: () => {}, question: "q", pointing: [], fast: false, onSpokenLine: () => {}, onDelta: () => {} }))
      .rejects.toThrow(/refused/);
  });
});
