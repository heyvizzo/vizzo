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

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
/** Tracks whether a promise settled, without awaiting it. */
function track<T>(p: Promise<T>) {
  const st = { settled: false, ok: false, err: undefined as unknown };
  p.then(() => Object.assign(st, { settled: true, ok: true }), (e) => Object.assign(st, { settled: true, err: e }));
  return st;
}
const creates = (ws: FakeSocket) => ws.sent.filter((e) => e.type === "response.create");
const created = (id: string, seq?: string) => ({ type: "response.created", response: { id, ...(seq ? { metadata: { seq } } : {}) } });
const done = (id: string, status = "completed") => ({ type: "response.done", response: { id, status } });

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
    // responseDone waits for the deferred answer too (not just the ack's response.done).
    let done1Resolved = false;
    const done1 = s.responseDone().then(() => (done1Resolved = true));
    ws.server({ type: "response.done", response: { id: "r1", status: "completed", usage: usage(1) } });
    await flush();
    expect(done1Resolved).toBe(false);
    expect(ws.types()).toEqual(["conversation.item.create", "response.create"]);

    const done2 = s.responseDone();
    ws.server({ type: "response.created", response: { id: "r2" } });
    expect(s.currentSegment).toBe("answer");
    ws.server(audio("r2", [2]));
    ws.server(audio("r2", [3]));
    ws.server({ type: "response.done", response: { id: "r2", status: "completed", usage: usage(2) } });
    await done2;
    await done1;
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

describe("openRealtime: chat features (speak, cancel, stale responses)", () => {
  it("sendToolResult respond:false sends only the function_call_output item", async () => {
    const { s, ws } = await open();
    ws.sent = [];
    s.sendToolResult("c1", "done in background", { respond: false });
    expect(ws.types()).toEqual(["conversation.item.create"]);
    expect(ws.sent[0].item).toEqual({ type: "function_call_output", call_id: "c1", output: "done in background" });
    await expect(s.responseDone()).resolves.toBeUndefined();
  });

  it("filler: out-of-band response.create payload", async () => {
    const { s, ws } = await open();
    ws.sent = [];
    void s.speak("Still checking the stylesheet.", "filler");
    expect(ws.types()).toEqual(["response.create"]);
    const r = ws.sent[0].response;
    expect(r).toMatchObject({
      conversation: "none",
      output_modalities: ["audio"],
      tool_choice: "none",
      reasoning: { effort: "minimal" },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Say exactly this and nothing else: Still checking the stylesheet." }] }],
      metadata: { kind: "filler" },
    });
    expect(r.instructions).toContain("Still checking the stylesheet.");
    expect(r.instructions).toMatch(/exactly/i);
  });

  it("notice: user note item, then response.create with tool_choice none (in-conversation)", async () => {
    const { s, ws } = await open();
    ws.sent = [];
    void s.speak("The refactor is done.", "notice");
    expect(ws.types()).toEqual(["conversation.item.create", "response.create"]);
    expect(ws.sent[0].item).toEqual({
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: "(System note: a background task you started for the user has finished. Tell the user in one or two short spoken sentences, naturally: The refactor is done.)",
      }],
    });
    expect(ws.sent[1].response).toMatchObject({ tool_choice: "none", metadata: { kind: "notice" } });
    expect(ws.sent[1].response.conversation).toBeUndefined();
    expect(ws.sent[1].response.input).toBeUndefined();
  });

  it("speak resolves at its own response.done; audio + text delivered; no marks; currentSegment", async () => {
    const { s, ws, rec } = await open();
    const chunks: number[][] = [];
    const texts: string[] = [];
    s.onAudio((b) => chunks.push([...b]));
    s.onText((t) => texts.push(t));
    s.beginTurn();
    const p = track(s.speak("One moment.", "filler"));
    ws.server(created("f1", creates(ws)[0].response.metadata.seq));
    expect(s.currentSegment).toBe("filler");
    ws.server({ type: "response.output_audio_transcript.delta", response_id: "f1", delta: "One moment." });
    ws.server(audio("f1", [9]));
    await flush();
    expect(p.settled).toBe(false);
    ws.server(done("f1"));
    await flush();
    expect(p.ok).toBe(true);
    expect(chunks).toEqual([[9]]);
    expect(texts).toEqual(["One moment."]);
    expect(rec.names()).toEqual([]); // no llm.firstToken / *.ttsFirstByte

    const n = track(s.speak("Job done.", "notice"));
    ws.server(created("n1"));
    expect(s.currentSegment).toBe("notice");
    ws.server(audio("n1", [8]));
    ws.server(done("n1"));
    await flush();
    expect(n.ok).toBe(true);
    expect(rec.names()).toEqual([]);
  });

  it("speak rejects on a failed response, a failed create, and on close", async () => {
    const { s, ws } = await open();
    const p1 = s.speak("a", "filler");
    ws.server(created("f1"));
    ws.server(done("f1", "failed"));
    await expect(p1).rejects.toThrow(/failed/);

    const p2 = s.speak("b", "notice");
    ws.server({ type: "error", error: { type: "invalid_request_error", message: "bad notice", event_id: creates(ws).at(-1).event_id } });
    await expect(p2).rejects.toThrow(/bad notice/);

    const p3 = s.speak("c", "filler");
    const p4 = s.speak("d", "filler"); // queued
    s.close();
    await expect(p3).rejects.toThrow(/closed/);
    await expect(p4).rejects.toThrow(/closed/);
    await expect(s.speak("e", "filler")).rejects.toThrow(/closed/);
  });

  it("socket close rejects active and queued speak promises", async () => {
    const { s, ws } = await open();
    const p1 = s.speak("a", "filler");
    const p2 = s.speak("b", "notice");
    ws.emit("close", 1006, Buffer.from("gone"));
    await expect(p1).rejects.toThrow(/socket closed/);
    await expect(p2).rejects.toThrow(/socket closed/);
  });

  it("filler, notice and answer run in order, one at a time", async () => {
    const { s, ws } = await open();
    ws.sent = [];
    void s.speak("f", "filler");
    void s.speak("n", "notice");
    s.sendToolResult("c1", "x");
    expect(ws.types()).toEqual(["response.create", "conversation.item.create"]); // filler create, tool output
    ws.server(created("f1"));
    ws.server(done("f1"));
    expect(ws.types().slice(2)).toEqual(["conversation.item.create", "response.create"]); // notice item + create
    expect(creates(ws)[1].response.metadata.kind).toBe("notice");
    ws.server(created("n1"));
    ws.server(done("n1"));
    expect(creates(ws)[2].response.metadata.kind).toBe("answer");
    expect(creates(ws)).toHaveLength(3);
  });

  it("a filler's done doesn't resolve a responseDone waiter; answer deferred behind the filler completes it", async () => {
    const { s, ws, rec } = await open();
    s.beginTurn();
    s.commitAndRespond();
    ws.server(created("r1"));
    ws.server(audio("r1", [1]));
    ws.server(done("r1"));
    await expect(s.responseDone()).resolves.toBeUndefined();

    // Opus is slow: a filler plays; the tool result arrives while the filler is still active.
    const f = track(s.speak("Still looking.", "filler"));
    await expect(s.responseDone()).resolves.toBeUndefined(); // filler alone doesn't count
    ws.server(created("f1"));
    ws.server(audio("f1", [2]));
    s.sendToolResult("c1", "answer text");
    expect(creates(ws)).toHaveLength(2); // answer create deferred behind the filler
    const w = track(s.responseDone());
    ws.server(done("f1"));
    await flush();
    expect(f.ok).toBe(true);
    expect(w.settled).toBe(false); // filler finishing must not resolve the answer waiter
    expect(creates(ws)).toHaveLength(3);
    ws.server(created("r2"));
    expect(s.currentSegment).toBe("answer");
    ws.server(audio("r2", [3]));
    await flush();
    expect(w.settled).toBe(false);
    ws.server(done("r2"));
    await flush();
    expect(w.ok).toBe(true);
    expect(rec.names()).toEqual(["llm.request", "llm.firstToken", "ack.ttsFirstByte", "answer.ttsFirstByte"]);
  });

  it("filler/notice audio before the answer doesn't steal llm.firstToken or answer.ttsFirstByte", async () => {
    const { s, ws, rec } = await open();
    s.beginTurn();
    void s.speak("filler first", "filler");
    ws.server(created("f1"));
    ws.server({ type: "response.output_audio_transcript.delta", response_id: "f1", delta: "filler" });
    ws.server(audio("f1", [1]));
    ws.server(done("f1"));
    expect(rec.names()).toEqual([]);
    s.sendToolResult("c1", "x");
    ws.server(created("r2"));
    ws.server(audio("r2", [2]));
    expect(rec.names()).toEqual(["llm.firstToken", "answer.ttsFirstByte"]);
  });

  it("cancelResponse: response.cancel with the active id, queued creates dropped, session usable", async () => {
    const { s, ws } = await open();
    s.beginTurn();
    s.commitAndRespond();
    ws.server(created("r1"));
    const f = track(s.speak("queued filler", "filler"));
    s.sendToolResult("c1", "x"); // queued answer
    const w = track(s.responseDone());
    ws.sent = [];
    s.cancelResponse();
    expect(ws.sent).toEqual([expect.objectContaining({ type: "response.cancel", response_id: "r1" })]);
    await flush();
    expect(f.ok).toBe(true); // dropped speak resolves
    expect(w.settled).toBe(false); // r1 is still active until its done
    ws.server(done("r1", "cancelled"));
    await flush();
    expect(w.ok).toBe(true);
    expect(ws.types()).toEqual(["response.cancel"]); // nothing queued went out
    // An error for the cancel (raced the end) is not surfaced.
    const errors: Error[] = [];
    s.onError((e) => errors.push(e));
    ws.server({ type: "error", error: { type: "invalid_request_error", message: "no active response", event_id: ws.sent[0].event_id } });
    expect(errors).toEqual([]);
    // Idle cancel sends nothing.
    s.cancelResponse();
    expect(ws.types()).toEqual(["response.cancel"]);
    // Still usable.
    s.commitAndRespond();
    expect(creates(ws)).toHaveLength(1);
  });

  it("cancelResponse before response.created: cancel goes out once the id is known; cancelled speak resolves", async () => {
    const { s, ws } = await open();
    const p = s.speak("filler", "filler");
    ws.sent = [];
    s.cancelResponse();
    expect(ws.sent).toEqual([]);
    ws.server(created("f1"));
    expect(ws.sent).toEqual([expect.objectContaining({ type: "response.cancel", response_id: "f1" })]);
    ws.server(done("f1", "cancelled"));
    await expect(p).resolves.toBeUndefined();
  });

  it("beginTurn: late events of the cancelled response are dropped; its done frees the slot only", async () => {
    const { s, ws, rec } = await open();
    const chunks: number[][] = [];
    const texts: string[] = [];
    const calls: ToolCall[] = [];
    s.onAudio((b) => chunks.push([...b]));
    s.onText((t) => texts.push(t));
    s.onToolCall((c) => calls.push(c));
    s.beginTurn();
    s.commitAndRespond();
    ws.server(created("old"));
    ws.server(audio("old", [1]));
    s.cancelResponse();
    void s.speak("queued from old turn", "filler");

    // Barge-in: new turn on the same session.
    const rec2 = recorder();
    s.setMark(rec2.mark);
    s.beginTurn();
    expect(creates(ws)).toHaveLength(1); // queued filler dropped
    await expect(s.responseDone()).resolves.toBeUndefined(); // the stale response doesn't count
    s.commitAndRespond();
    expect(creates(ws)).toHaveLength(1); // new ack waits for the slot
    const w = track(s.responseDone());

    // Late events from the cancelled response.
    ws.server(audio("old", [2]));
    ws.server({ type: "response.output_audio_transcript.delta", response_id: "old", delta: "stale" });
    ws.server({ type: "response.output_item.added", response_id: "old", item: { type: "function_call", call_id: "cx", name: "ask_opus" } });
    ws.server({ type: "response.function_call_arguments.done", response_id: "old", call_id: "cx", name: "ask_opus", arguments: "{}" });
    ws.server(done("old", "cancelled"));
    await flush();
    expect(w.settled).toBe(false); // stale done resolves no new-turn waiter
    expect(creates(ws)).toHaveLength(2); // ...but frees the slot
    expect(chunks).toEqual([[1]]);
    expect(texts).toEqual([]);
    expect(calls).toEqual([]);

    ws.server(created("new"));
    expect(s.currentSegment).toBe("ack");
    ws.server(audio("new", [3]));
    ws.server(done("new"));
    await flush();
    expect(w.ok).toBe(true);
    expect(chunks).toEqual([[1], [3]]);
    expect(rec.names()).toEqual(["llm.request", "llm.firstToken", "ack.ttsFirstByte"]);
    expect(rec2.names()).toEqual(["llm.request", "llm.firstToken", "ack.ttsFirstByte"]);
  });

  it("beginTurn: a create sent but not yet response.created becomes stale too", async () => {
    const { s, ws, rec } = await open();
    const chunks: number[][] = [];
    s.onAudio((b) => chunks.push([...b]));
    s.beginTurn();
    s.commitAndRespond(); // create sent, no response.created yet
    s.cancelResponse();
    s.beginTurn();
    s.commitAndRespond();
    expect(creates(ws)).toHaveLength(1);
    ws.server(created("old")); // the stale create's response
    expect(ws.sent.at(-1)).toMatchObject({ type: "response.cancel", response_id: "old" });
    ws.server(audio("old", [1]));
    ws.server(done("old", "cancelled"));
    expect(creates(ws)).toHaveLength(2);
    ws.server(created("new"));
    ws.server(audio("new", [2]));
    expect(chunks).toEqual([[2]]);
    expect(rec.names()).toEqual(["llm.request", "llm.request", "llm.firstToken", "ack.ttsFirstByte"]);
  });
});
