// ElevenLabs streaming TTS (T5). ARCHITECTURE §4, API-NOTES "ElevenLabs TTS".
//
// One socket PER SEGMENT: the vendor only signals end-of-segment after end-of-stream, so
// flush() = force generation + close, and done() resolves on the final message or socket close.
//
// Two WebSocket protocols behind the same TtsStream, selected by `model`:
//   eleven_flash_v2_5 → TTS stream-input      wss://…/v1/text-to-speech/{voice}/stream-input
//   eleven_v4_turbo   → Text-to-Dialogue (TTD) wss://…/v1/text-to-dialogue/stream-input
// plus an HTTP-per-sentence fallback (`openTtsHttp`), selected when TTS_TRANSPORT=http.
//
// Output is always PCM16 mono 24 kHz (`output_format=pcm_24000`). Every onAudio Buffer has even
// length: a base64 chunk may end mid-sample, so the odd trailing byte is carried to the next chunk.
import WebSocket from "ws";
import type { OpenTts, OpenTtsOpts, TtsStream } from "./types.ts";
import type { TtsModel } from "../../shared/config.ts";

const WS_BASE = "wss://api.elevenlabs.io/v1";
const HTTP_BASE = "https://api.elevenlabs.io/v1";
const OUTPUT_FORMAT = "pcm_24000";

/**
 * Flash chunk_length_schedule (chars buffered before each successive generation; vendor range 50–500).
 * The vendor default [120,160,250,290] means no audio until 120 chars. We start at the minimum (50)
 * so the first audio comes after ~one short clause, then grow so later chunks keep good prosody.
 * Short segments (an ack like "Sure, one sec.") never reach 50 chars; flush() forces them out.
 */
export const FLASH_CHUNK_SCHEDULE = [50, 90, 120, 150];
const FLASH_VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.8, use_speaker_boost: false, speed: 1.0 };
/** TTD voice_settings only accepts `stability`. */
const TTD_VOICE_SETTINGS = { stability: 0.5 };
/** TTD inactivity limit is a fixed 20 s; flash we open with inactivity_timeout=180 but ping as well. */
export const KEEP_ALIVE_MS = 15_000;

// ---------- injectable deps ----------

/** The subset of the `ws` client we use, so tests can inject a fake. */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  // open | message(data) | close(code, reason) | error(err) | unexpected-response(req, res)
  on(event: string, listener: (...args: any[]) => void): unknown;
}
export type WsCtor = new (url: string, opts: { headers: Record<string, string> }) => WsLike;
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}>;

export interface TtsDeps {
  WebSocket?: WsCtor;
  fetch?: FetchLike;
  apiKey?: string;
  /** Debug logger (default: console.debug when TTS_DEBUG is set). */
  log?: (...args: unknown[]) => void;
}

const WS_OPEN = 1;

function defaultLog(...args: unknown[]): void {
  if (process.env.TTS_DEBUG) console.debug("[tts]", ...args);
}

function resolveKey(deps: TtsDeps): string {
  const key = deps.apiKey ?? process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY not set");
  return key;
}

// ---------- shared helpers ----------

/** Re-chunks PCM16 so every emitted Buffer has an even byte length. */
export class Pcm16Carry {
  private carry: Buffer | null = null;
  push(chunk: Buffer): Buffer | null {
    let buf = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
    this.carry = null;
    if (buf.length % 2 === 1) {
      this.carry = Buffer.from(buf.subarray(buf.length - 1));
      buf = buf.subarray(0, buf.length - 1);
    }
    return buf.length ? buf : null;
  }
  /** Bytes left over at end of stream (0 or 1); they can't form a sample and are dropped. */
  get pending(): number {
    return this.carry ? this.carry.length : 0;
  }
}

/**
 * Word-boundary chunker for streamed LLM text. TTS stream-input wants each text chunk to end with a
 * space, so a trailing partial word ("stic" of "sticky") is held until whitespace arrives. That word
 * couldn't be spoken yet anyway, so this adds no audible latency; everything up to the last
 * whitespace is sent immediately (no time-based coalescing).
 */
export class WordChunker {
  private buf = "";
  push(delta: string): string | null {
    this.buf += delta;
    const m = /\s(?=\S*$)/.exec(this.buf);
    if (!m) return null;
    const out = this.buf.slice(0, m.index + 1);
    this.buf = this.buf.slice(m.index + 1);
    return out;
  }
  /** Remaining partial word, if any. */
  drain(): string | null {
    const out = this.buf;
    this.buf = "";
    return out ? out : null;
  }
}

/**
 * Splits buffered text into complete sentences. A sentence ends at . ! ? … (plus closing quotes or
 * brackets) followed by whitespace, or at a newline. Text without a terminator stays in `rest`.
 */
export function splitSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  const re = /[.!?…]+["'”’)\]]*\s+|\n+/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    const s = text.slice(start, end).trim();
    if (s) sentences.push(s);
    start = end;
  }
  return { sentences, rest: text.slice(start) };
}

/** Looks for container headers that would mean we got something other than raw PCM. */
export function sniffNonPcm(buf: Buffer): string | null {
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "RIFF") return "WAV (RIFF header)";
  if (buf.length >= 3 && buf.subarray(0, 3).toString("latin1") === "ID3") return "MP3 (ID3 tag)";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "OggS") return "Ogg";
  // No bare MP3 frame-sync check: 0xFF 0xEx is an ordinary PCM16 sample and misfired on real pcm_24000 output.
  return null;
}

/** Common audio-out / first-byte / done plumbing for every transport. */
class StreamCore {
  chars = 0;
  private readonly listeners: ((b: Buffer) => void)[] = [];
  private readonly pendingAudio: Buffer[] = [];
  private readonly carry = new Pcm16Carry();
  private firstByte = false;
  private settled = false;
  private resolveDone!: () => void;
  private rejectDone!: (e: Error) => void;
  readonly donePromise: Promise<void>;

  constructor(private readonly opts: OpenTtsOpts, private readonly log: (...a: unknown[]) => void, readonly transport: string) {
    this.donePromise = new Promise<void>((res, rej) => {
      this.resolveDone = res;
      this.rejectDone = rej;
    });
    // done() may be awaited late (or never); don't crash the process on an unobserved rejection.
    this.donePromise.catch(() => {});
  }

  onAudio(cb: (b: Buffer) => void): void {
    this.listeners.push(cb);
    if (this.listeners.length === 1) for (const b of this.pendingAudio.splice(0)) cb(b);
  }

  audio(raw: Buffer): void {
    if (!raw.length || this.settled) return;
    if (!this.firstByte) {
      this.firstByte = true;
      this.opts.mark(this.opts.segment === "ack" ? "ack.ttsFirstByte" : "answer.ttsFirstByte", { model: this.opts.model, bytes: raw.length });
      // pcm_24000 on the WS endpoints is documented as "Any type"; log the first chunk so a live run can confirm it.
      this.log(`first audio chunk: ${raw.length} bytes (${this.transport}, ${this.opts.model}, ${this.opts.segment})`);
      const odd = sniffNonPcm(raw);
      if (odd) console.warn(`[tts] first audio chunk looks like ${odd}, not raw PCM16; check output_format=${OUTPUT_FORMAT}`);
    }
    const buf = this.carry.push(raw);
    if (!buf) return;
    if (this.listeners.length) for (const cb of this.listeners) cb(buf);
    else this.pendingAudio.push(buf);
  }

  get isSettled(): boolean {
    return this.settled;
  }

  resolve(): void {
    if (this.settled) return;
    this.settled = true;
    if (this.carry.pending) this.log(`dropping ${this.carry.pending} trailing odd byte`);
    this.resolveDone();
  }

  reject(err: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectDone(err);
  }
}

// ---------- WebSocket transports ----------

interface Protocol {
  url(voiceId: string, model: TtsModel): string;
  init(voiceId: string): unknown;
  text(chunk: string, voiceId: string): unknown;
  flush(): unknown[];
  keepAlive(): unknown;
}

const flashProtocol: Protocol = {
  url: (voiceId, model) =>
    `${WS_BASE}/text-to-speech/${encodeURIComponent(voiceId)}/stream-input?model_id=${model}&output_format=${OUTPUT_FORMAT}&inactivity_timeout=180`,
  init: () => ({ text: " ", voice_settings: FLASH_VOICE_SETTINGS, generation_config: { chunk_length_schedule: FLASH_CHUNK_SCHEDULE } }),
  text: (chunk) => ({ text: chunk }),
  // flush forces generation of the buffer; {"text":""} is end-of-stream → isFinal → server closes.
  flush: () => [{ text: " ", flush: true }, { text: "" }],
  keepAlive: () => ({ text: " " }),
};

const dialogueProtocol: Protocol = {
  url: (_voiceId, model) => `${WS_BASE}/text-to-dialogue/stream-input?model_id=${model}&output_format=${OUTPUT_FORMAT}`,
  // First message must register exactly one voice for eleven_v4_turbo; never resend it.
  init: (voiceId) => ({ voices: [voiceId], voice_settings: TTD_VOICE_SETTINGS }),
  text: (chunk, voiceId) => ({ inputs: [{ text: chunk, voice_id: voiceId }] }),
  // close_socket flushes, sends remaining audio, then is_final, then closes.
  flush: () => [{ flush: true }, { close_socket: true }],
  keepAlive: () => ({ keep_alive: true }),
};

export function protocolFor(model: TtsModel): "tts" | "dialogue" {
  return model === "eleven_v4_turbo" ? "dialogue" : "tts";
}

/** Close codes we treat as a vendor/protocol failure when no final message arrived. */
function isErrorClose(code: number): boolean {
  return code === 1002 || code === 1003 || code === 1007 || code === 1008 || code === 1011 || code >= 4000;
}

export function createOpenTtsWs(deps: TtsDeps = {}): OpenTts {
  const Ws = deps.WebSocket ?? (WebSocket as unknown as WsCtor);
  const log = deps.log ?? defaultLog;

  return (opts) =>
    new Promise<TtsStream>((resolveOpen, rejectOpen) => {
      const kind = protocolFor(opts.model);
      const proto = kind === "dialogue" ? dialogueProtocol : flashProtocol;
      const core = new StreamCore(opts, log, `ws:${kind}`);
      const chunker = new WordChunker();
      let opened = false;
      let flushed = false;
      let closed = false;
      let keepAlive: ReturnType<typeof setTimeout> | null = null;
      const queue: string[] = [];

      let ws: WsLike;
      try {
        ws = new Ws(proto.url(opts.voiceId, opts.model), { headers: { "xi-api-key": resolveKey(deps) } });
      } catch (e) {
        rejectOpen(e instanceof Error ? e : new Error(String(e)));
        return;
      }

      const clearKeepAlive = () => {
        if (keepAlive) clearTimeout(keepAlive);
        keepAlive = null;
      };
      // Idle-only keep-alive: re-armed on every send, stopped once flushed or closed. Matters for
      // pre-warmed sockets that sit open before the segment's text arrives.
      const armKeepAlive = () => {
        clearKeepAlive();
        if (flushed || closed) return;
        keepAlive = setTimeout(() => {
          keepAlive = null;
          if (!flushed && !closed) send(proto.keepAlive());
        }, KEEP_ALIVE_MS);
        (keepAlive as { unref?: () => void }).unref?.();
      };
      const send = (msg: unknown) => {
        const s = JSON.stringify(msg);
        if (opened && ws.readyState === WS_OPEN) ws.send(s);
        else if (!opened) queue.push(s);
        else return;
        if (opened) armKeepAlive();
      };
      const fail = (err: Error) => {
        if (!opened) rejectOpen(err);
        core.reject(err);
        shutdown();
      };
      const shutdown = () => {
        if (closed) return;
        closed = true;
        clearKeepAlive();
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      };

      ws.on("unexpected-response", (_req: unknown, res: { statusCode?: number }) => {
        fail(new Error(`TTS WebSocket upgrade failed: HTTP ${res?.statusCode ?? "?"}`));
      });
      ws.on("error", (err: Error) => fail(err instanceof Error ? err : new Error(String(err))));
      ws.on("open", () => {
        opened = true;
        ws.send(JSON.stringify(proto.init(opts.voiceId)));
        for (const s of queue.splice(0)) ws.send(s);
        armKeepAlive();
        resolveOpen(stream);
      });
      ws.on("message", (raw: unknown) => {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          log("non-JSON message ignored");
          return;
        }
        if (ev.error) {
          fail(new Error(`ElevenLabs TTS error: ${String(ev.error)}${ev.message ? ` — ${String(ev.message)}` : ""}`));
          return;
        }
        if (typeof ev.audio === "string" && ev.audio) core.audio(Buffer.from(ev.audio, "base64"));
        if (ev.is_final_audio_for_turn) log("is_final_audio_for_turn");
        // TTS reference uses camelCase isFinal; TTD and some guide samples use is_final. Accept both.
        if (ev.isFinal === true || ev.is_final === true) {
          core.resolve();
          shutdown();
        }
      });
      ws.on("close", (code: number, reason: unknown) => {
        const wasClosed = closed;
        closed = true;
        clearKeepAlive();
        const why = reason ? String(reason) : "";
        if (!opened) {
          rejectOpen(new Error(`TTS WebSocket closed before open: ${code} ${why}`));
          core.reject(new Error(`closed before open: ${code}`));
          return;
        }
        if (!wasClosed && isErrorClose(code)) core.reject(new Error(`TTS WebSocket closed: ${code} ${why}`));
        else core.resolve();
      });

      const stream: TtsStream = {
        pushText(delta) {
          if (!delta) return;
          if (flushed || closed) {
            log("pushText after flush/close ignored");
            return;
          }
          core.chars += delta.length;
          const chunk = chunker.push(delta);
          if (chunk) send(proto.text(chunk, opts.voiceId));
        },
        flush() {
          if (flushed || closed) return;
          const rest = chunker.drain();
          if (rest) send(proto.text(kind === "tts" ? rest + " " : rest, opts.voiceId));
          for (const m of proto.flush()) send(m);
          flushed = true;
          clearKeepAlive();
        },
        onAudio: (cb) => core.onAudio(cb),
        done: () => core.donePromise,
        close() {
          shutdown();
          core.resolve();
        },
        get chars() {
          return core.chars;
        },
      };
    });
}

// ---------- HTTP-per-sentence fallback ----------

/**
 * Same interface over HTTP streaming: text is buffered and split into sentences, each sentence is
 * one POST (sequential), and response bytes stream straight to onAudio. Flash uses
 * /text-to-speech/{voice}/stream (confirmed in docs). eleven_v4_turbo uses /text-to-dialogue/stream,
 * which the docs do NOT confirm for v4 Turbo (API-NOTES 🔧); expect it may fail.
 */
export function createOpenTtsHttp(deps: TtsDeps = {}): OpenTts {
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const log = deps.log ?? defaultLog;

  return async (opts) => {
    const key = resolveKey(deps);
    const core = new StreamCore(opts, log, "http");
    const abort = new AbortController();
    let buf = "";
    let flushed = false;
    let closed = false;
    let spoken = "";
    const queue: string[] = [];
    let running = false;

    const request = async (text: string) => {
      const dialogue = protocolFor(opts.model) === "dialogue";
      const url = dialogue
        ? `${HTTP_BASE}/text-to-dialogue/stream?output_format=${OUTPUT_FORMAT}`
        : `${HTTP_BASE}/text-to-speech/${encodeURIComponent(opts.voiceId)}/stream?output_format=${OUTPUT_FORMAT}`;
      const body = dialogue
        ? { inputs: [{ text, voice_id: opts.voiceId }], model_id: opts.model }
        : { text, model_id: opts.model, voice_settings: FLASH_VOICE_SETTINGS, ...(spoken ? { previous_text: spoken.slice(-300) } : {}) };
      const res = await doFetch(url, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`ElevenLabs TTS HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      if (!res.body) return;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (closed) {
          await reader.cancel().catch(() => {});
          return;
        }
        if (value?.length) core.audio(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
      spoken += (spoken ? " " : "") + text;
    };

    const pump = async () => {
      if (running) return;
      running = true;
      try {
        while (queue.length && !closed) await request(queue.shift()!);
        if (flushed && !queue.length) core.resolve();
      } catch (e) {
        if (!closed) core.reject(e instanceof Error ? e : new Error(String(e)));
      } finally {
        running = false;
      }
      // A sentence may have been queued while the last request was finishing.
      if (queue.length && !closed && !core.isSettled) void pump();
    };

    const stream: TtsStream = {
      pushText(delta) {
        if (!delta || flushed || closed) return;
        core.chars += delta.length;
        buf += delta;
        const { sentences, rest } = splitSentences(buf);
        buf = rest;
        if (sentences.length) {
          queue.push(...sentences);
          void pump();
        }
      },
      flush() {
        if (flushed || closed) return;
        flushed = true;
        const rest = buf.trim();
        buf = "";
        if (rest) queue.push(rest);
        void pump();
      },
      onAudio: (cb) => core.onAudio(cb),
      done: () => core.donePromise,
      close() {
        if (closed) return;
        closed = true;
        abort.abort();
        core.resolve();
      },
      get chars() {
        return core.chars;
      },
    };
    return stream;
  };
}

// ---------- default exports ----------

const wsImpl = createOpenTtsWs();
const httpImpl = createOpenTtsHttp();

/** WebSocket transport by default; HTTP-per-sentence when TTS_TRANSPORT=http. */
export const openTts: OpenTts = (opts) => (process.env.TTS_TRANSPORT === "http" ? httpImpl(opts) : wsImpl(opts));
export const openTtsHttp: OpenTts = httpImpl;
