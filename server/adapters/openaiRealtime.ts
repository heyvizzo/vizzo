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
// - Responses are strictly serialized: one `response.create` in flight at a time, later ones (ack, answer,
//   filler, notice) wait in a FIFO queue until the active response's `response.done` (or its create failed).
//   The API allows parallel out-of-band responses, but we play one audio stream, so fillers queue too.
//   Every create carries `metadata: {kind, seq}`, checked against `response.created`.
// - `responseDone()` only tracks ack/answer responses of the current turn; filler/notice/stale ones don't count.
// - `beginTurn()` marks the in-flight response stale (its audio/text/tool calls are dropped, its done only frees
//   the slot) and drops queued requests. `cancelResponse()` drops queued requests and sends
//   `response.cancel {response_id}` (deferred to `response.created` if the id isn't known yet; without an id the
//   API only cancels default-conversation responses, which would miss an out-of-band filler).
// - speak() promises: resolve at their response.done (completed/cancelled/incomplete), reject on status
//   "failed", a failed create, socket error/close or close(). Requests dropped before being sent
//   (cancelResponse/beginTurn) resolve: the drop is deliberate, not an error.
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

  // Response tracking. Only one response runs at a time (see header): `active` holds the response.create
  // that was sent and whose response.done hasn't arrived; later requests wait in `queue` (FIFO).
  type Kind = RealtimeSession["currentSegment"];
  interface Req {
    kind: Kind;
    seq: number;
    /** response.create `response` override (undefined → bare response.create). */
    response?: Record<string, unknown>;
    /** Events sent right before the response.create (the notice's conversation item). */
    before?: Record<string, unknown>[];
    createEventId?: string;
    responseId?: string;
    /** From before the last beginTurn: events dropped, done resolves no waiters. */
    stale: boolean;
    /** cancelResponse() ran before response.created gave us the id: cancel on response.created. */
    cancelPending: boolean;
    /** speak() promise callbacks. */
    resolve?: () => void;
    reject?: (e: Error) => void;
  }
  let reqSeq = 0;
  let active: Req | null = null;
  let queue: Req[] = [];
  const staleIds = new Set<string>();
  const kindById = new Map<string, Kind>();
  const cancelEventIds = new Set<string>();
  let currentSegment: Kind = "ack";
  let waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];

  const isTurnKind = (k: Kind) => k === "ack" || k === "answer";

  const emitError = (err: Error) => {
    for (const cb of errorCbs) cb(err);
  };
  /** An ack/answer response is active or queued (not stale): what responseDone() waits for. */
  const turnResponseOutstanding = () =>
    (active !== null && !active.stale && isTurnKind(active.kind)) || queue.some((r) => isTurnKind(r.kind));
  const settleWaiters = () => {
    if (turnResponseOutstanding()) return;
    const w = waiters;
    waiters = [];
    for (const x of w) x.resolve();
  };
  const rejectWaiters = (err: Error) => {
    const w = waiters;
    waiters = [];
    for (const x of w) x.reject(err);
  };
  /** Dropped (never sent) requests: speak() promises resolve, the drop is deliberate (cancel / new turn). */
  const dropQueue = () => {
    const q = queue;
    queue = [];
    for (const r of q) r.resolve?.();
  };
  /** Fatal: reject everything outstanding. */
  const failAll = (err: Error) => {
    const all = [...(active ? [active] : []), ...queue];
    active = null;
    queue = [];
    for (const r of all) r.reject?.(err);
    rejectWaiters(err);
  };

  const pump = () => {
    if (active || closed) return;
    const r = queue.shift();
    if (!r) return;
    active = r;
    for (const ev of r.before ?? []) send(ev);
    // metadata is echoed on response.created/done (API-NOTES: identifies parallel / out-of-band responses).
    const response = { ...r.response, metadata: { kind: r.kind, seq: String(r.seq) } };
    r.createEventId = send({ type: "response.create", response });
  };
  const enqueue = (r: Omit<Req, "seq" | "stale" | "cancelPending">) => {
    queue.push({ ...r, seq: ++reqSeq, stale: false, cancelPending: false });
    pump();
  };

  const sendCancel = (responseId: string) => {
    cancelEventIds.add(send({ type: "response.cancel", response_id: responseId }));
  };

  /** Stale events are dropped. Events without a response_id are attributed to the active response. */
  const isStale = (responseId: unknown): boolean =>
    typeof responseId === "string" ? staleIds.has(responseId) : !!active?.stale;
  const kindOf = (responseId: unknown): Kind =>
    (typeof responseId === "string" && kindById.get(responseId)) || active?.kind || currentSegment;

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
        const id = ev.response?.id;
        if (!active || typeof id !== "string") break;
        const seq = ev.response?.metadata?.seq;
        if (seq !== undefined && seq !== String(active.seq)) {
          log(`response.created for unexpected response ${id} (metadata seq ${seq}, active ${active.seq})`);
          break;
        }
        active.responseId = id;
        kindById.set(id, active.kind);
        if (active.stale) staleIds.add(id);
        else currentSegment = active.kind;
        if (active.cancelPending) {
          active.cancelPending = false;
          sendCancel(id);
        }
        break;
      }
      case "response.output_audio.delta": {
        if (typeof ev.delta !== "string" || isStale(ev.response_id)) break;
        const pcm = Buffer.from(ev.delta, "base64");
        const kind = kindOf(ev.response_id);
        if (isTurnKind(kind)) markFirstToken();
        if (kind === "ack" && !ackMarked) {
          ackMarked = true;
          mark("ack.ttsFirstByte");
        } else if (kind === "answer" && !answerMarked) {
          answerMarked = true;
          mark("answer.ttsFirstByte");
        }
        for (const cb of audioCbs) cb(pcm);
        break;
      }
      case "response.output_audio_transcript.delta":
      case "response.output_text.delta": {
        if (typeof ev.delta !== "string" || isStale(ev.response_id)) break;
        if (isTurnKind(kindOf(ev.response_id))) markFirstToken();
        for (const cb of textCbs) cb(ev.delta);
        break;
      }
      case "response.output_item.added": {
        if (isStale(ev.response_id)) break;
        const item = ev.item;
        if (item?.type === "function_call") markToolCall(String(item.call_id ?? item.id), item.name);
        break;
      }
      case "response.function_call_arguments.done": {
        if (isStale(ev.response_id)) break;
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
        const id = typeof r.id === "string" ? r.id : undefined;
        if (id) {
          kindById.delete(id);
          staleIds.delete(id);
        }
        // Only the active response frees the slot (ids match, or response.created never gave us one).
        if (!active || (id && active.responseId && active.responseId !== id)) break;
        const done = active;
        active = null;
        if (r.status === "failed") {
          done.reject?.(new Error(`OpenAI realtime: ${done.kind} response failed: ${JSON.stringify(r.status_details ?? null)}`));
        } else done.resolve?.(); // completed, cancelled or incomplete: that response is over
        pump();
        settleWaiters();
        break;
      }
      case "error": {
        const e = ev.error ?? {};
        const msg = `OpenAI realtime error: ${e.type ?? "error"}/${e.code ?? ""}: ${e.message ?? JSON.stringify(e)}`;
        // response.cancel that raced the response's end ("no active response"): harmless, not surfaced.
        if (typeof e.event_id === "string" && cancelEventIds.delete(e.event_id)) {
          log(`ignored (response.cancel): ${msg}`);
          break;
        }
        const err = new Error(msg);
        log(err.message);
        // A failed response.create means no response.done will come: free the slot, fail that request.
        if (active && typeof e.event_id === "string" && e.event_id === active.createEventId) {
          const failed = active;
          active = null;
          if (failed.reject) failed.reject(err);
          else if (!failed.stale) rejectWaiters(err);
          pump();
          settleWaiters();
        }
        emitError(err);
        break;
      }
      default:
        break; // ignore unknown types (API-NOTES)
    }
  };

  const speakRequest = (text: string, kind: "filler" | "notice"): Omit<Req, "seq" | "stale" | "cancelPending"> => {
    if (kind === "filler") {
      return {
        kind,
        response: {
          conversation: "none", // out-of-band: not written to the conversation
          output_modalities: ["audio"],
          tool_choice: "none",
          reasoning: { effort: "minimal" },
          instructions: `You are a voice. Say exactly the sentence you are given, word for word, nothing else: ${text}`,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `Say exactly this and nothing else: ${text}` }] }],
        },
      };
    }
    return {
      kind,
      before: [
        {
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: `(System note: a background task you started for the user has finished. Tell the user in one or two short spoken sentences, naturally: ${text})`,
            }],
          },
        },
      ],
      response: { tool_choice: "none" },
    };
  };

  const session: RealtimeSession = {
    beginTurn() {
      firstTokenMarked = false;
      ackMarked = false;
      answerMarked = false;
      toolCallMarked.clear();
      currentSegment = "ack";
      // Whatever is still in flight belongs to the previous turn.
      if (active) {
        active.stale = true;
        if (active.responseId) staleIds.add(active.responseId);
      }
      dropQueue();
      settleWaiters();
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
      send({ type: "input_audio_buffer.commit" });
      if (extraContext) {
        send({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_text", text: extraContext }] },
        });
      }
      mark("llm.request");
      enqueue({ kind: "ack" });
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
    sendToolResult(callId, output, opts) {
      send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
      if (opts?.respond !== false) enqueue({ kind: "answer" });
    },
    speak(text, kind) {
      if (closed) return Promise.reject(new Error("openRealtime: session closed"));
      return new Promise<void>((resolve, reject) => enqueue({ ...speakRequest(text, kind), resolve, reject }));
    },
    cancelResponse() {
      dropQueue();
      if (active) {
        if (active.responseId) sendCancel(active.responseId);
        else active.cancelPending = true; // id arrives with response.created
      }
      settleWaiters();
    },
    responseDone() {
      if (closed) return Promise.reject(new Error("openRealtime: session closed"));
      if (!turnResponseOutstanding()) return Promise.resolve();
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
      failAll(new Error("openRealtime: session closed"));
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
      failAll(err);
      emitError(err);
    });
    ws.on("close", (code, reason) => {
      if (!ready) return fail(new Error(`openRealtime: socket closed during setup (${code} ${reason?.toString() ?? ""})`));
      if (closed) return;
      closed = true;
      const err = new Error(`openRealtime: socket closed (${code} ${reason?.toString() ?? ""})`);
      failAll(err);
      emitError(err);
    });
  });
}

export const openRealtime: OpenRealtime = createOpenRealtime();
