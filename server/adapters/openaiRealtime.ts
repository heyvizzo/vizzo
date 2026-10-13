// OpenAI Realtime adapter (T4). GA `/v1/realtime` over a raw WebSocket; shapes per docs/API-NOTES.md §OpenAI Realtime.
//
// Design notes:
// - `openRealtime` resolves after `session.updated` (we wait for `session.created`, send `session.update`,
//   then wait for the server to confirm the effective config). This costs one extra round trip at open,
//   but the session is pre-warmed (ARCHITECTURE §7), so it's off the latency path and guarantees that
//   push-to-talk (turn_detection: null) is active before any audio is appended.
// - The session is reused across turns: callbacks persist; `beginTurn()` clears the input buffer and
//   resets per-turn mark state; `setMark()` swaps the per-turn mark function.
// - Context items (`commitAndRespond(extraContext)`) use `role: "user"` with `input_text` content. API-NOTES says
//   user or system both work; user is the shape shown in the client-events reference example.
// - Only one response may be active per conversation, so a `response.create` requested while a response is
//   still in flight (e.g. sendToolResult before the ack response's `response.done`) is deferred until it finishes.
import WebSocket from "ws";
import type { Mark, OpenRealtime, OpenRealtimeOpts, RealtimeSession, RealtimeUsage, ToolCall, ToolDef } from "./types.ts";

const DEFAULT_VOICE = "marin"; // API-NOTES: marin/cedar are recommended.
const OPEN_TIMEOUT_MS = 15_000;

/** The subset of the `ws` WebSocket API this adapter uses; lets tests inject a fake socket. */
export interface RealtimeSocket {
  on(event: "open", cb: () => void): unknown;
  on(event: "message", cb: (data: unknown) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "close", cb: (code: number, reason: Buffer) => void): unknown;
  send(data: string): void;
  close(): void;
}
export type RealtimeSocketCtor = new (url: string, opts: { headers: Record<string, string> }) => RealtimeSocket;

export interface RealtimeDeps {
  WebSocket?: RealtimeSocketCtor;
  apiKey?: string;
  /** Logger for errors (default console.error). */
  log?: (...args: unknown[]) => void;
}

type ServerEvent = { type?: string; [k: string]: any };

export function toRealtimeTool(t: ToolDef): Record<string, unknown> {
  return { type: "function", name: t.name, description: t.description, parameters: t.parameters };
}

export function buildSessionUpdate(opts: OpenRealtimeOpts): Record<string, unknown> {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: opts.instructions,
      output_modalities: ["audio"],
      audio: {
        input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: null },
        output: { format: { type: "audio/pcm", rate: 24000 }, voice: opts.voice ?? DEFAULT_VOICE },
      },
      // Documented field; the default is not, so set it explicitly (API-NOTES §OpenAI Realtime).
      reasoning: { effort: "low" },
      tools: opts.tools.map(toRealtimeTool),
      tool_choice: "auto",
    },
  };
}

function emptyUsage(): RealtimeUsage {
  return {
    responses: [],
    totals: {
      inputTokens: 0, outputTokens: 0, inputText: 0, inputAudio: 0,
      cachedText: 0, cachedAudio: 0, cached: 0, outputText: 0, outputAudio: 0,
    },
  };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function addUsage(acc: RealtimeUsage, u: any): void {
  if (!u || typeof u !== "object") return;
  acc.responses.push(u);
  const t = acc.totals;
  const inD = u.input_token_details ?? {};
  const outD = u.output_token_details ?? {};
  const cD = inD.cached_tokens_details ?? {};
  t.inputTokens += num(u.input_tokens);
  t.outputTokens += num(u.output_tokens);
  t.inputText += num(inD.text_tokens);
  t.inputAudio += num(inD.audio_tokens);
  t.cached += num(inD.cached_tokens);
  t.cachedText += num(cD.text_tokens);
  t.cachedAudio += num(cD.audio_tokens);
  t.outputText += num(outD.text_tokens);
  t.outputAudio += num(outD.audio_tokens);
}

function safeJson(s: unknown): unknown {
  if (typeof s !== "string") return s ?? {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s, _parseError: true };
  }
}

function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

export function createOpenRealtime(deps: RealtimeDeps = {}): OpenRealtime {
  return (opts) => openRealtimeWith(opts, deps);
}

async function openRealtimeWith(opts: OpenRealtimeOpts, deps: RealtimeDeps): Promise<RealtimeSession> {
  const apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("openRealtime: OPENAI_API_KEY not set");
  const Ctor = deps.WebSocket ?? (WebSocket as unknown as RealtimeSocketCtor);
  const log = deps.log ?? ((...a: unknown[]) => console.error("[openaiRealtime]", ...a));

  const ws = new Ctor(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(opts.model)}`, {
    headers: { Authorization: `Bearer ${apiKey}` }, // GA: no OpenAI-Beta header
  });

  let mark: Mark = opts.mark;
  let closed = false;
  let eventSeq = 0;
  const send = (ev: Record<string, unknown>): string => {
    const event_id = `evt_${++eventSeq}`;
    if (!closed) ws.send(JSON.stringify({ event_id, ...ev }));
    return event_id;
  };

  const audioCbs: ((pcm: Buffer) => void)[] = [];
  const textCbs: ((d: string) => void)[] = [];
  const toolCbs: ((c: ToolCall) => void)[] = [];
  const errorCbs: ((e: Error) => void)[] = [];
  const usage = emptyUsage();

  // Per-turn mark state.
  let firstTokenMarked = false;
  let ackMarked = false;
  let answerMarked = false;
  const toolCallMarked = new Set<string>();

  // Response tracking.
  type Segment = "ack" | "answer";
  let pendingSegment: Segment = "ack"; // segment for the next response.create
  const requestedSegments: Segment[] = []; // FIFO of response.create sent, awaiting response.created
  const responseSegment = new Map<string, Segment>();
  let currentSegment: Segment = "ack";
  let responseActive = false; // a response.create was sent and its response.done hasn't arrived
  let deferredCreate: Segment | null = null;
  const createEventIds = new Set<string>();
  let waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];

  const emitError = (err: Error) => {
    for (const cb of errorCbs) cb(err);
  };
  const resolveWaiters = () => {
    const w = waiters;
    waiters = [];
    for (const x of w) x.resolve();
  };
  const rejectWaiters = (err: Error) => {
    const w = waiters;
    waiters = [];
    for (const x of w) x.reject(err);
  };

  const sendResponseCreate = (segment: Segment) => {
    if (responseActive) {
      deferredCreate = segment;
      return;
    }
    responseActive = true;
    requestedSegments.push(segment);
    createEventIds.add(send({ type: "response.create" }));
  };

  const segmentOf = (responseId: unknown): Segment =>
    (typeof responseId === "string" && responseSegment.get(responseId)) || currentSegment;

  const markFirstToken = () => {
    if (!firstTokenMarked) {
      firstTokenMarked = true;
      mark("llm.firstToken");
    }
  };

  const markToolCall = (callId: string, name: unknown) => {
    if (toolCallMarked.has(callId)) return;
    toolCallMarked.add(callId);
    mark("llm.toolCall", { name });
  };

  const onEvent = (ev: ServerEvent) => {
    switch (ev.type) {
      case "response.created": {
        const seg = requestedSegments.shift() ?? pendingSegment;
        const id = ev.response?.id;
        if (typeof id === "string") responseSegment.set(id, seg);
        currentSegment = seg;
        break;
      }
      case "response.output_audio.delta": {
        if (typeof ev.delta !== "string") break;
        const pcm = Buffer.from(ev.delta, "base64");
        markFirstToken();
        const seg = segmentOf(ev.response_id);
        if (seg === "ack" && !ackMarked) {
          ackMarked = true;
          mark("ack.ttsFirstByte");
        } else if (seg === "answer" && !answerMarked) {
          answerMarked = true;
          mark("answer.ttsFirstByte");
        }
        for (const cb of audioCbs) cb(pcm);
        break;
      }
      case "response.output_audio_transcript.delta":
      case "response.output_text.delta": {
        if (typeof ev.delta !== "string") break;
        markFirstToken();
        for (const cb of textCbs) cb(ev.delta);
        break;
      }
      case "response.output_item.added": {
        const item = ev.item;
        if (item?.type === "function_call") markToolCall(String(item.call_id ?? item.id), item.name);
        break;
      }
      case "response.function_call_arguments.done": {
        const callId = String(ev.call_id);
        markToolCall(callId, ev.name); // fallback if output_item.added lacked the item
        const call: ToolCall = { callId, name: String(ev.name ?? ""), args: safeJson(ev.arguments) };
        for (const cb of toolCbs) cb(call);
        break;
      }
      case "response.done": {
        const r = ev.response ?? {};
        addUsage(usage, r.usage);
        if (r.status && r.status !== "completed") log(`response ${r.id} status=${r.status}`, JSON.stringify(r.status_details ?? null));
        if (typeof r.id === "string") responseSegment.delete(r.id);
        responseActive = false;
        resolveWaiters();
        if (deferredCreate) {
          const seg = deferredCreate;
          deferredCreate = null;
          sendResponseCreate(seg);
        }
        break;
      }
      case "error": {
        const e = ev.error ?? {};
        const err = new Error(`OpenAI realtime error: ${e.type ?? "error"}/${e.code ?? ""}: ${e.message ?? JSON.stringify(e)}`);
        log(err.message);
        // A failed response.create means no response.done will come: treat it as fatal for pending waiters.
        if (typeof e.event_id === "string" && createEventIds.has(e.event_id)) {
          createEventIds.delete(e.event_id);
          responseActive = false;
          requestedSegments.shift();
          rejectWaiters(err);
        }
        emitError(err);
        break;
      }
      default:
        break; // ignore unknown types (API-NOTES)
    }
  };

  const session: RealtimeSession = {
    beginTurn() {
      firstTokenMarked = false;
      ackMarked = false;
      answerMarked = false;
      toolCallMarked.clear();
      pendingSegment = "ack";
      currentSegment = "ack";
      send({ type: "input_audio_buffer.clear" });
    },
    setMark(m) {
      mark = m;
    },
    pushAudio(pcm) {
      if (pcm.length === 0) return;
      send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
    },
    commitAndRespond(extraContext) {
      pendingSegment = "ack";
      send({ type: "input_audio_buffer.commit" });
      if (extraContext) {
        send({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text: extraContext }] },
        });
      }
      mark("llm.request");
      sendResponseCreate("ack");
    },
    onAudio(cb) {
      audioCbs.push(cb);
    },
    onText(cb) {
      textCbs.push(cb);
    },
    onToolCall(cb) {
      toolCbs.push(cb);
    },
    onError(cb) {
      errorCbs.push(cb);
    },
    sendToolResult(callId, output) {
      pendingSegment = "answer";
      send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
      sendResponseCreate("answer");
    },
    speak() {
      return Promise.reject(new Error("speak: not implemented")); // TEMP stub (realtime agent)
    },
    cancelResponse() {
      send({ type: "response.cancel" }); // TEMP stub (realtime agent)
    },
    responseDone() {
      if (closed) return Promise.reject(new Error("openRealtime: session closed"));
      if (!responseActive && !deferredCreate) return Promise.resolve();
      return new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
    },
    get currentSegment() {
      return currentSegment;
    },
    get usage() {
      return usage;
    },
    close() {
      if (closed) return;
      closed = true;
      rejectWaiters(new Error("openRealtime: session closed"));
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };

  return new Promise<RealtimeSession>((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => fail(new Error(`openRealtime: no session.updated within ${OPEN_TIMEOUT_MS} ms`)), OPEN_TIMEOUT_MS);
    const fail = (err: Error) => {
      if (ready) return;
      ready = true;
      clearTimeout(timer);
      session.close();
      reject(err);
    };

    ws.on("message", (data) => {
      let ev: ServerEvent;
      try {
        ev = JSON.parse(toText(data)) as ServerEvent;
      } catch {
        log("unparseable server message");
        return;
      }
      if (!ready) {
        if (ev.type === "session.created") send(buildSessionUpdate(opts));
        else if (ev.type === "session.updated") {
          ready = true;
          clearTimeout(timer);
          resolve(session);
        } else if (ev.type === "error") {
          fail(new Error(`openRealtime: error during setup: ${ev.error?.message ?? JSON.stringify(ev.error)}`));
        }
        return;
      }
      onEvent(ev);
    });
    ws.on("error", (err) => {
      if (!ready) return fail(err);
      log("socket error:", err.message);
      rejectWaiters(err);
      emitError(err);
    });
    ws.on("close", (code, reason) => {
      if (!ready) return fail(new Error(`openRealtime: socket closed during setup (${code} ${reason?.toString() ?? ""})`));
      if (closed) return;
      closed = true;
      const err = new Error(`openRealtime: socket closed (${code} ${reason?.toString() ?? ""})`);
      rejectWaiters(err);
      emitError(err);
    });
  });
}

export const openRealtime: OpenRealtime = createOpenRealtime();
