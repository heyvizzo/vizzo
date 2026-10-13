import { describe, expect, it } from "vitest";
import { createOpenRealtime, type RealtimeSocket } from "./openaiRealtime.ts";
import { ASK_OPUS_TOOL, type Mark, type RealtimeSession, type ToolCall } from "./types.ts";

type Handler = (...a: any[]) => void;

class FakeSocket implements RealtimeSocket {
  static last: FakeSocket | null = null;
  handlers = new Map<string, Handler[]>();
  sent: any[] = [];
  closed = false;
  constructor(public url: string, public opts: { headers: Record<string, string> }) {
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.emit("open");
      this.server({ type: "session.created", session: {} });
    });
  }
  on(event: string, cb: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
    return this;
  }
  send(data: string) {
    const ev = JSON.parse(data);
    this.sent.push(ev);
    if (ev.type === "session.update") queueMicrotask(() => this.server({ type: "session.updated", session: ev.session }));
  }
  close() {
    this.closed = true;
  }
  emit(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
  server(ev: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(ev)));
  }
  types() {
    return this.sent.map((e) => e.type);
  }
}

function recorder() {
  const marks: { name: string; meta?: Record<string, unknown> }[] = [];
  const mark: Mark = (name, meta) => marks.push(meta ? { name, meta } : { name });
  return { marks, mark, names: () => marks.map((m) => m.name) };
}

async function open(extra: { voice?: string } = {}) {
  const rec = recorder();
  const openRealtime = createOpenRealtime({ WebSocket: FakeSocket, apiKey: "sk-test", log: () => {} });
  const s = await openRealtime({ mark: rec.mark, model: "gpt-realtime-2.1-mini", instructions: "Be terse.", tools: [ASK_OPUS_TOOL], ...extra });
  return { s, ws: FakeSocket.last!, rec };
}

const audio = (id: string, bytes: number[]) => ({ type: "response.output_audio.delta", response_id: id, delta: Buffer.from(bytes).toString("base64") });
const usage = (i: number) => ({
  total_tokens: 10 * i, input_tokens: 6 * i, output_tokens: 4 * i,
  input_token_details: { text_tokens: 2 * i, audio_tokens: 4 * i, cached_tokens: i, cached_tokens_details: { text_tokens: i, audio_tokens: 0 } },
  output_token_details: { text_tokens: i, audio_tokens: 3 * i },
});

describe("openRealtime", () => {
  it("connects with auth and sends the session.update shape from API-NOTES", async () => {
    const { ws } = await open();
    expect(ws.url).toBe("wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini");
    expect(ws.opts.headers).toEqual({ Authorization: "Bearer sk-test" });
    const up = ws.sent.find((e) => e.type === "session.update");
    expect(up.session).toEqual({
      type: "realtime",
      instructions: "Be terse.",
      output_modalities: ["audio"],
      audio: {
        input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: null },
        output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" },
      },
      reasoning: { effort: "low" },
      tools: [{ type: "function", name: "ask_opus", description: ASK_OPUS_TOOL.description, parameters: ASK_OPUS_TOOL.parameters }],
      tool_choice: "auto",
    });
  });

  it("honours opts.voice", async () => {
    const { ws } = await open({ voice: "cedar" });
    expect(ws.sent.find((e) => e.type === "session.update").session.audio.output.voice).toBe("cedar");
  });

  it("rejects without an API key", async () => {
    const o = createOpenRealtime({ WebSocket: FakeSocket, apiKey: "" });
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await expect(o({ mark: () => {}, model: "gpt-realtime-2.1", instructions: "", tools: [] })).rejects.toThrow(/OPENAI_API_KEY/);
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  });

  it("pushAudio appends base64; commit flow without context", async () => {
    const { s, ws, rec } = await open();
    ws.sent = [];
    s.beginTurn();
    s.pushAudio(Buffer.from([1, 2, 3, 4]));
    s.commitAndRespond();
    expect(ws.types()).toEqual(["input_audio_buffer.clear", "input_audio_buffer.append", "input_audio_buffer.commit", "response.create"]);
    expect(ws.sent[1].audio).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
    expect(rec.names()).toEqual(["llm.request"]);
  });

  it("commit flow with context inserts a user input_text item before response.create", async () => {
    const { s, ws } = await open();
    ws.sent = [];
    s.commitAndRespond("Pointing: <button>");
    expect(ws.types()).toEqual(["input_audio_buffer.commit", "conversation.item.create", "response.create"]);
    expect(ws.sent[1].item).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "Pointing: <button>" }] });
  });

  it("audio delta → callback + llm.firstToken + ack.ttsFirstByte once", async () => {
    const { s, ws, rec } = await open();
    const chunks: Buffer[] = [];
    const texts: string[] = [];
    s.onAudio((b) => chunks.push(b));
    s.onText((t) => texts.push(t));
    s.beginTurn();
    s.commitAndRespond();
    ws.server({ type: "response.created", response: { id: "r1" } });
    ws.server({ type: "response.output_audio_transcript.delta", response_id: "r1", delta: "Hi" });
    ws.server(audio("r1", [1, 2]));
    ws.server(audio("r1", [3, 4]));
    expect(chunks.map((c) => [...c])).toEqual([[1, 2], [3, 4]]);
    expect(texts).toEqual(["Hi"]);
    expect(rec.names()).toEqual(["llm.request", "llm.firstToken", "ack.ttsFirstByte"]);
    expect(s.currentSegment).toBe("ack");
  });

  it("tool call flow: llm.toolCall, onToolCall, sendToolResult, answer.ttsFirstByte", async () => {
    const { s, ws, rec } = await open();
    const calls: ToolCall[] = [];
    s.onToolCall((c) => calls.push(c));
    s.beginTurn();
    s.commitAndRespond();
    ws.server({ type: "response.created", response: { id: "r1" } });
    ws.server(audio("r1", [1]));
    ws.server({ type: "response.output_item.added", response_id: "r1", item: { type: "function_call", id: "it1", call_id: "c1", name: "ask_opus", arguments: "" } });
    ws.server({ type: "response.function_call_arguments.done", item_id: "it1", call_id: "c1", name: "ask_opus", arguments: '{"question":"why sticky?"}' });
    expect(calls).toEqual([{ callId: "c1", name: "ask_opus", args: { question: "why sticky?" } }]);

    // Tool result before the ack response is done: item sent now, response.create deferred.
    ws.sent = [];
    s.sendToolResult("c1", "It keeps nav visible.");
    expect(ws.types()).toEqual(["conversation.item.create"]);
    expect(ws.sent[0].item).toEqual({ type: "function_call_output", call_id: "c1", output: "It keeps nav visible." });
    const done1 = s.responseDone();
    ws.server({ type: "response.done", response: { id: "r1", status: "completed", usage: usage(1) } });
    await done1;
    expect(ws.types()).toEqual(["conversation.item.create", "response.create"]);

    const done2 = s.responseDone();
    ws.server({ type: "response.created", response: { id: "r2" } });
    expect(s.currentSegment).toBe("answer");
    ws.server(audio("r2", [2]));
    ws.server(audio("r2", [3]));
    ws.server({ type: "response.done", response: { id: "r2", status: "completed", usage: usage(2) } });
    await done2;
    expect(rec.marks).toEqual([
      { name: "llm.request" },
      { name: "llm.firstToken" },
      { name: "ack.ttsFirstByte" },
      { name: "llm.toolCall", meta: { name: "ask_opus" } },
      { name: "answer.ttsFirstByte" },
    ]);
  });

  it("bad tool args JSON doesn't throw", async () => {
    const { s, ws } = await open();
    const calls: ToolCall[] = [];
    s.onToolCall((c) => calls.push(c));
    ws.server({ type: "response.function_call_arguments.done", call_id: "c9", name: "ask_opus", arguments: "{oops" });
    expect(calls[0]!.args).toEqual({ _raw: "{oops", _parseError: true });
  });

  it("accumulates usage across responses", async () => {
    const { s, ws } = await open();
    ws.server({ type: "response.done", response: { id: "a", status: "completed", usage: usage(1) } });
    ws.server({ type: "response.done", response: { id: "b", status: "completed", usage: usage(2) } });
    expect(s.usage.responses).toHaveLength(2);
    expect(s.usage.totals).toEqual({
      inputTokens: 18, outputTokens: 12, inputText: 6, inputAudio: 12,
      cachedText: 3, cachedAudio: 0, cached: 3, outputText: 3, outputAudio: 9,
    });
  });

  it("multi-turn reuse: setMark swaps marks, per-turn state resets, callbacks persist", async () => {
    const { s, ws, rec } = await open();
    let audioCount = 0;
    s.onAudio(() => audioCount++);
    const turn = async (sess: RealtimeSession, id: string) => {
      sess.beginTurn();
      sess.pushAudio(Buffer.from([0, 0]));
      sess.commitAndRespond();
      const done = sess.responseDone();
      ws.server({ type: "response.created", response: { id } });
      ws.server(audio(id, [1]));
      ws.server({ type: "response.done", response: { id, status: "completed", usage: usage(1) } });
      await done;
    };
    await turn(s, "r1");
    const rec2 = recorder();
    s.setMark(rec2.mark);
    await turn(s, "r2");
    expect(rec.names()).toEqual(["llm.request", "llm.firstToken", "ack.ttsFirstByte"]);
    expect(rec2.names()).toEqual(["llm.request", "llm.firstToken", "ack.ttsFirstByte"]);
    expect(audioCount).toBe(2);
    expect(s.usage.responses).toHaveLength(2);
    expect(ws.types().filter((t) => t === "input_audio_buffer.clear")).toHaveLength(2);
  });

  it("responseDone resolves immediately when idle; rejects on failed response.create and on close", async () => {
    const { s, ws } = await open();
    const errors: Error[] = [];
    s.onError((e) => errors.push(e));
    await expect(s.responseDone()).resolves.toBeUndefined();
    s.commitAndRespond();
    const createId = ws.sent.at(-1).event_id;
    const p = s.responseDone();
    ws.server({ type: "error", error: { type: "invalid_request_error", code: "x", message: "bad", event_id: createId } });
    await expect(p).rejects.toThrow(/bad/);
    expect(errors).toHaveLength(1);

    // Recoverable error not tied to response.create: surfaced but doesn't reject.
    s.commitAndRespond();
    const p2 = s.responseDone();
    ws.server({ type: "error", error: { type: "invalid_request_error", message: "meh", event_id: "other" } });
    expect(errors).toHaveLength(2);
    s.close();
    s.close(); // idempotent
    await expect(p2).rejects.toThrow(/closed/);
    expect(ws.closed).toBe(true);
  });
});
