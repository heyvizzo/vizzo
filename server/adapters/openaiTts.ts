// OpenAI text-to-speech (`tts-1`, "optimized for realtime text-to-speech") behind the TtsStream interface.
// POST /v1/audio/speech with response_format "pcm" returns raw 24 kHz 16-bit signed little-endian mono —
// the lab's audio format — streamed with chunked transfer encoding. Text goes a sentence at a time; the
// next sentence is requested while the current one streams, and audio is delivered in order.
// Price: $15 per 1M characters (docs/API-NOTES.md).
import type { OpenTts, TtsStream } from "./types.ts";
import { takeSentences } from "./sentences.ts";

export const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";
/** Voices tts-1 supports (the guide lists these for tts-1 / tts-1-hd); voices are optimized for English. */
export const TTS1_VOICES = ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"] as const;
const DEFAULT_VOICE = "coral";

export interface OpenAiTtsDeps {
  fetch?: typeof fetch;
  apiKey?: string;
  voice?: string;
}

/** One sentence's request: its audio is buffered until every earlier sentence has been delivered. */
interface Piece { chunks: Buffer[]; done: boolean; error?: Error; ready: Promise<void> }

export function createOpenAiTts(deps: OpenAiTtsDeps = {}): OpenTts {
  return async ({ mark, segment, model }) => {
    const apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    const voice = deps.voice ?? process.env.OPENAI_TTS_VOICE ?? DEFAULT_VOICE;
    const doFetch = deps.fetch ?? fetch;
    const apiModel = model === "openai_tts_1" ? "tts-1" : model;
    const audioCbs: ((b: Buffer) => void)[] = [];
    const early: Buffer[] = [];
    const pieces: Piece[] = [];
    let delivered = 0; // index of the piece whose audio goes out now
    let rest = "";
    let chars = 0;
    let closed = false;
    let flushed = false;
    let firstByte = false;
    const t0 = performance.now();
    let wake: (() => void) | null = null;

    const emit = (b: Buffer) => {
      if (closed || !b.length) return;
      if (!firstByte) {
        firstByte = true;
        mark(segment === "answer" ? "answer.ttsFirstByte" : "ack.ttsFirstByte", { model: apiModel, voice, bytes: b.length, ms: Math.round(performance.now() - t0) });
      }
      if (audioCbs.length) for (const cb of audioCbs) cb(b);
      else early.push(b);
    };
    /** Send out what the head piece has, in order; move on when it's finished. */
    const pump = () => {
      while (delivered < pieces.length) {
        const p = pieces[delivered]!;
        for (const c of p.chunks.splice(0)) emit(c);
        if (!p.done) return;
        delivered++;
      }
      wake?.();
    };

    const request = (text: string) => {
      if (!text.trim() || closed) return;
      const piece: Piece = { chunks: [], done: false, ready: Promise.resolve() };
      pieces.push(piece);
      piece.ready = (async () => {
        let carry: Buffer | null = null; // odd trailing byte between this response's chunks
        try {
          const res = await doFetch(OPENAI_TTS_URL, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: apiModel, input: text, voice, response_format: "pcm" }),
          });
          if (!res.ok || !res.body) throw new Error(`OpenAI TTS ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            if (closed) break;
            let b = Buffer.from(chunk);
            if (carry) { b = Buffer.concat([carry, b]); carry = null; }
            if (b.length % 2) { carry = b.subarray(b.length - 1); b = b.subarray(0, b.length - 1); }
            piece.chunks.push(b);
            pump();
          }
        } catch (e) {
          piece.error = e instanceof Error ? e : new Error(String(e));
        } finally {
          piece.done = true;
          pump();
        }
      })();
    };

    const stream: TtsStream = {
      pushText(delta) {
        if (closed || flushed || !delta) return;
        chars += delta.length;
        const [sentences, tail] = takeSentences(rest + delta);
        rest = tail;
        for (const s of sentences) request(s);
      },
      flush() {
        if (flushed) return;
        flushed = true;
        request(rest);
        rest = "";
      },
      onAudio(cb) {
        audioCbs.push(cb);
        for (const b of early.splice(0)) cb(b);
      },
      async done() {
        stream.flush();
        await Promise.all(pieces.map((p) => p.ready));
        if (delivered < pieces.length) await new Promise<void>((r) => { wake = r; pump(); });
        const failed = pieces.find((p) => p.error);
        if (failed && !closed) throw failed.error;
      },
      close() { closed = true; },
      get chars() { return chars; },
    };
    return stream;
  };
}

export const openOpenAiTts: OpenTts = createOpenAiTts();
