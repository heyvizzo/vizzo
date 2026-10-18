// Sentence-at-a-time TTS over HTTP (OpenAI tts-1, Fish Audio drama-3) behind the TtsStream interface.
// One request per sentence, its raw 24 kHz PCM16 mono body streamed in chunks. The next sentence is
// requested while the current one streams, and audio is delivered in sentence order.
import type { Mark } from "../clock.ts";
import type { OpenTtsOpts, TtsStream } from "./types.ts";
import { takeSentences } from "./sentences.ts";

export interface SentenceTtsOpts {
  /** Starts one sentence's request; resolves to its PCM body (rejects on HTTP error). */
  fetchPcm: (text: string) => Promise<AsyncIterable<Uint8Array>>;
  mark: Mark;
  segment: OpenTtsOpts["segment"];
  /** Added to the first-byte mark (model, voice). */
  markMeta: Record<string, unknown>;
}

/** One sentence's request: its audio is buffered until every earlier sentence has been delivered. */
interface Piece { chunks: Buffer[]; done: boolean; error?: Error; ready: Promise<void> }

export function openSentenceTts({ fetchPcm, mark, segment, markMeta }: SentenceTtsOpts): TtsStream {
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
      mark(segment === "answer" ? "answer.ttsFirstByte" : "ack.ttsFirstByte", { ...markMeta, bytes: b.length, ms: Math.round(performance.now() - t0) });
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
        const body = await fetchPcm(text);
        for await (const chunk of body) {
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
}
