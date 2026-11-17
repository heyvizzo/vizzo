// ElevenLabs Scribe v2 Realtime STT adapter (T3). Shapes per docs/API-NOTES.md "ElevenLabs Scribe".
//
// Lifecycle (one session per turn, one client commit on release):
// - `openScribe` resolves as soon as the WebSocket is OPEN, so the orchestrator is never blocked on
//   the vendor handshake. Audio (and a commit) pushed before the server's `session_started` is
//   buffered and flushed when `session_started` arrives — the probe and docs only show audio sent
//   after `session_started`, so we don't send earlier. Connect failures reject `openScribe`.
// - Audio is coalesced into 100 ms – 1 s messages (the documented recommended chunk size);
//   `commit()` flushes whatever is pending, then sends the empty-audio commit chunk.
// - Scribe also auto-commits after ~36 s, even in manual mode. Keep each segment's text and
//   session-relative word timestamps; partials expose the committed prefix plus the current segment.
// - `final()` waits for the release segment and all timestamp responses. After 3 s it can fall back
//   to the combined plain text (no words if any segment lacks timestamps). An empty release segment
//   or no-speech response preserves earlier speech. Late partials after finalization are ignored.
import WebSocket from "ws";
import type { Word } from "../../shared/protocol.ts";
import { serverNow } from "../clock.ts";
import type { OpenScribe, OpenScribeOpts, SttStream } from "./types.ts";

export const SCRIBE_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const RATE = 24000;
const BYTES_PER_SEC = RATE * 2;
const MIN_SEND_BYTES = BYTES_PER_SEC / 10; // 100 ms
const MAX_SEND_BYTES = BYTES_PER_SEC; // 1 s

/** Error `message_type`s from the realtime event reference. */
const ERROR_TYPES = new Set([
  "auth_error", "quota_exceeded", "transcriber_error", "input_error", "invalid_request", "error",
  "commit_throttled", "unaccepted_terms", "rate_limited", "queue_overflow", "resource_exhausted",
  "session_time_limit_exceeded", "chunk_size_exceeded", "insufficient_audio_activity",
]);

/** The subset of a `ws` WebSocket the adapter uses (injectable for tests). */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}
export type WsFactory = (url: string, headers: Record<string, string>) => WsLike;

export interface ScribeDeps {
  wsFactory?: WsFactory;
  apiKey?: () => string | undefined;
  /** Plain-transcript fallback delay after commit (default 3000). */
  fallbackMs?: number;
  /** Give up waiting for any transcript this long after commit (default 10000). */
  finalTimeoutMs?: number;
}

const defaultFactory: WsFactory = (url, headers) => new WebSocket(url, { headers });

export function buildScribeUrl(keyterms?: string[], language?: string): string {
  const qs = new URLSearchParams({
    model_id: "scribe_v2_realtime",
    audio_format: "pcm_24000",
    commit_strategy: "manual",
    include_timestamps: "true",
  });
  // Omitted → Scribe detects the language (and returns it on the timestamped commit).
  if (language) qs.set("language_code", language);
  // Repeated query param; docs limit: ≤50 terms, ≤20 chars each.
  for (const k of (keyterms ?? []).map((s) => s.trim()).filter((s) => s && s.length <= 20).slice(0, 50)) {
    qs.append("keyterms", k);
  }
  return `${SCRIBE_URL}?${qs}`;
}

interface VendorWord { text?: unknown; start?: unknown; end?: unknown; type?: unknown }

export function filterWords(words: unknown): Word[] {
  if (!Array.isArray(words)) return [];
  return (words as VendorWord[])
    .filter((w) => w && w.type === "word" && typeof w.text === "string")
    .map((w) => ({ text: w.text as string, start: Number(w.start), end: Number(w.end) }));
}

type FinalResult = { text: string; words: Word[]; language?: string };
interface TranscriptSegment {
  text: string;
  /** This segment's plain response arrived after the release commit was sent. */
  afterCommit: boolean;
  plainAt?: number;
  words?: Word[];
  language?: string;
  timestampDelayMs?: number;
}

const joinText = (parts: string[]): string => parts.map((s) => s.trim()).filter(Boolean).join(" ");

export function createOpenScribe(deps: ScribeDeps = {}): OpenScribe {
  const factory = deps.wsFactory ?? defaultFactory;
  const getKey = deps.apiKey ?? (() => process.env.ELEVENLABS_API_KEY);
  const fallbackMs = deps.fallbackMs ?? 3000;
  const finalTimeoutMs = deps.finalTimeoutMs ?? 10_000;

  return (opts: OpenScribeOpts) =>
    new Promise<SttStream>((resolveOpen, rejectOpen) => {
      const key = getKey();
      if (!key) {
        rejectOpen(new Error("openScribe: ELEVENLABS_API_KEY not set"));
        return;
      }
      const { mark } = opts;
      const ws = factory(buildScribeUrl(opts.keyterms, opts.language), { "xi-api-key": key });

      let opened = false;
      let ready = false; // session_started received
      let committed = false; // commit() called
      let commitSent = false;
      let closed = false;
      let settled = false;
      let sentFirstPartial = false;
      let bytesSent = 0;
      let pending: Buffer[] = [];
      let pendingBytes = 0;
      let tCommit = 0;
      const segments: TranscriptSegment[] = [];
      let partialText = "";
      let fallbackDue = false;
      let lastError: { type: string; error: string } | null = null;
      const partialCbs: ((text: string) => void)[] = [];
      const timers: ReturnType<typeof setTimeout>[] = [];

      let resolveFinal!: (r: FinalResult) => void;
      let rejectFinal!: (e: Error) => void;
      const finalP = new Promise<FinalResult>((res, rej) => {
        resolveFinal = res;
        rejectFinal = rej;
      });
      finalP.catch(() => {}); // callers may never call final(); avoid unhandled rejections

      const sendChunk = (b: Buffer, commit: boolean) => {
        ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b.toString("base64"), commit, sample_rate: RATE }));
        bytesSent += b.length;
      };

      /** Send pending audio in [MIN, MAX]-sized messages; `all` also sends a short tail. */
      const flushAudio = (all: boolean) => {
        if (!ready || closed || ws.readyState !== WebSocket.OPEN) return;
        if (pendingBytes < (all ? 1 : MIN_SEND_BYTES)) return;
        let buf = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
        while (buf.length >= MIN_SEND_BYTES || (all && buf.length > 0)) {
          // Keep whole samples; don't leave a sub-100 ms tail when splitting > 1 s.
          let n = Math.min(buf.length, MAX_SEND_BYTES);
          if (buf.length > MAX_SEND_BYTES && buf.length - n < MIN_SEND_BYTES) n = Math.floor(buf.length / 2 / 2) * 2;
          sendChunk(buf.subarray(0, n), false);
          buf = buf.subarray(n);
        }
        if (buf.length) {
          pending = [buf];
          pendingBytes = buf.length;
        }
      };

      const sendCommitIfDue = () => {
        if (!committed || commitSent || !ready || closed || ws.readyState !== WebSocket.OPEN) return;
        flushAudio(true);
        sendChunk(Buffer.alloc(0), true); // empty audio + commit:true (confirmed in API-NOTES)
        commitSent = true;
      };

      const clearTimers = () => timers.splice(0).forEach(clearTimeout);

      const finish = (r: FinalResult, meta: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimers();
        mark("stt.final", { words: r.words.length, ...meta, ...(tCommit ? { commitToFinalMs: Math.round(serverNow() - tCommit) } : {}) });
        resolveFinal(r);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        rejectFinal(err);
      };
      const finishTranscript = (meta: Record<string, unknown> = {}) => {
        const timestamped = segments.length > 0 && segments.every((s) => s.words !== undefined);
        const language = segments.findLast((s) => s.language)?.language;
        const delay = segments.at(-1)?.timestampDelayMs;
        finish({
          text: joinText(segments.map((s) => s.text)),
          // A partial word list would truncate the annotated transcript sent to the router.
          words: timestamped ? segments.flatMap((s) => s.words!) : [],
          ...(language ? { language } : {}),
        }, {
          timestamped, segments: segments.length,
          ...(language ? { language } : {}),
          ...(delay !== undefined ? { plainToTimestampedMs: delay } : {}),
          ...meta,
        });
      };
      const finishIfReady = () => {
        // A timestamp response for a pre-release auto-commit can arrive after release. It isn't
        // the final segment: wait for a new committed segment, including an empty one.
        if (!commitSent || !segments.some((s) => s.afterCommit)) return;
        if (segments.every((s) => s.words !== undefined)) finishTranscript();
        else if (fallbackDue) finishTranscript({ fallback: "timeout" });
      };
      const publishPartial = () => {
        const text = joinText([...segments.map((s) => s.text), partialText]);
        for (const cb of partialCbs) cb(text);
      };

      const handleMessage = (raw: unknown) => {
        if (settled || closed) return;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = String(ev.message_type);
        switch (type) {
          case "session_started":
            ready = true;
            flushAudio(false);
            sendCommitIfDue();
            return;
          case "partial_transcript": {
            const text = typeof ev.text === "string" ? ev.text : "";
            if (!sentFirstPartial && text.trim()) {
              sentFirstPartial = true;
              mark("stt.firstPartial", { text });
            }
            partialText = text;
            publishPartial();
            return;
          }
          case "committed_transcript": {
            segments.push({ text: typeof ev.text === "string" ? ev.text : "", plainAt: serverNow(), afterCommit: commitSent });
            partialText = "";
            publishPartial();
            finishIfReady();
            return;
          }
          case "committed_transcript_with_timestamps": {
            const words = filterWords(ev.words);
            const text = typeof ev.text === "string" ? ev.text : words.map((w) => w.text).join(" ");
            // Pair the delayed timestamp event with its plain event. Matching only unfinished
            // segments keeps repeated phrases, and also handles timestamp work finishing out of order.
            let segment = segments.find((s) => s.words === undefined && (typeof ev.text !== "string" || s.text === text));
            if (!segment) {
              segment = { text, afterCommit: commitSent };
              segments.push(segment); // tolerate a timestamp response without its plain counterpart
              partialText = "";
              publishPartial();
            }
            segment.words = words;
            if (typeof ev.language_code === "string" && ev.language_code) segment.language = ev.language_code;
            if (segment.plainAt !== undefined) segment.timestampDelayMs = Math.round(serverNow() - segment.plainAt);
            finishIfReady();
            return;
          }
          default:
            if (ERROR_TYPES.has(type) || typeof ev.error === "string") {
              lastError = { type, error: String(ev.error ?? "") };
              if (type === "insufficient_audio_activity") {
                if (committed) finishTranscript({ error: type });
              } else if (committed && segments.length && !partialText.trim()) {
                finishTranscript({ fallback: `error:${type}` });
              } else {
                fail(new Error(`scribe ${type}: ${lastError.error}`));
              }
            }
          // warning, committed_transcript_entities, edited_transcript, unknown types: ignore
        }
      };

      ws.on("open", () => {
        opened = true;
        resolveOpen(stream);
      });
      ws.on("message", (data: unknown) => handleMessage(data));
      ws.on("unexpected-response", (_req: unknown, res: { statusCode?: number }) => {
        const err = new Error(`scribe: HTTP ${res?.statusCode ?? "?"} on upgrade`);
        if (!opened) rejectOpen(err);
        fail(err);
        closeSocket();
      });
      ws.on("error", (e: Error) => {
        const err = new Error(`scribe socket error: ${e?.message ?? e}`);
        if (!opened) rejectOpen(err);
        if (committed && segments.length && !partialText.trim()) finishTranscript({ fallback: "socket-error" });
        else fail(err);
      });
      ws.on("close", (code: number, reason: unknown) => {
        closed = true;
        const r = reason ? String(reason) : "";
        const why = `scribe socket closed (${code ?? "?"}${r ? ` ${r}` : ""})`;
        if (!opened) rejectOpen(new Error(why));
        if (committed && segments.length && !partialText.trim()) finishTranscript({ fallback: "socket-close" });
        else fail(new Error(lastError ? `${why} after ${lastError.type}: ${lastError.error}` : `${why} before final`));
      });

      const closeSocket = () => {
        if (closed) return;
        closed = true;
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      };

      const stream: SttStream = {
        pushAudio(pcm24k: Buffer) {
          if (committed || settled || closed || pcm24k.length === 0) return; // audio after release is ignored
          pending.push(pcm24k);
          pendingBytes += pcm24k.length;
          flushAudio(false);
        },
        commit() {
          if (committed || settled || closed) return;
          committed = true;
          tCommit = serverNow();
          sendCommitIfDue();
          timers.push(
            setTimeout(() => {
              fallbackDue = true;
              finishIfReady();
            }, fallbackMs),
            setTimeout(() => {
              // If release landed on an auto-commit boundary Scribe may have no new segment.
              // Never silently return just the prefix while uncommitted speech is still visible.
              if (segments.length && (!partialText.trim() || segments.some((s) => s.afterCommit))) finishTranscript({ fallback: "timeout" });
              else fail(new Error(`scribe: no transcript within ${finalTimeoutMs} ms of commit`));
            }, finalTimeoutMs),
          );
        },
        onPartial(cb) {
          partialCbs.push(cb);
        },
        final: () => finalP,
        close() {
          if (closed && settled) return;
          fail(new Error("scribe: closed before final"));
          closeSocket();
        },
        get seconds() {
          return bytesSent / BYTES_PER_SEC;
        },
      };
    });
}

export const openScribe: OpenScribe = createOpenScribe();
