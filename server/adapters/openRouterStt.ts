// OpenRouter speech-to-text behind the same SttStream as Scribe. Models: openai/whisper-large-v3 (default),
// fish-audio/transcribe-1 and nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b (see STT_OPENROUTER_MODEL).
// Batch, not streaming: audio is buffered while the key is held and sent once on commit() as a 24 kHz
// mono WAV, POST /api/v1/audio/transcriptions (JSON, base64 input_audio). No partial transcripts, so
// onPartial never fires. verbose_json with word timestamps gives `words` in seconds from the first audio
// sample, the same convention as Scribe's one-session-per-turn, so pointing works unchanged.
// (gpt-4o(-mini)-transcribe reject verbose_json, so they can't provide word timing.)
// Price per audio second by model: cost.ts (PRICES.openRouterSttPerSecond).
import type { Word } from "../../shared/protocol.ts";
import { STT_OPENROUTER_MODEL } from "../../shared/config.ts";
import type { OpenScribe, SttStream } from "./types.ts";

export const OPENROUTER_STT_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
export const WHISPER_MODEL = "openai/whisper-large-v3";
const RATE = 24000;
const BYTES_PER_SEC = RATE * 2;

export interface OpenRouterSttDeps {
  fetch?: typeof fetch;
  apiKey?: string;
  /** Give up on the request after this long (default 30 s; the provider's own limit is 60 s). */
  timeoutMs?: number;
  /** OpenRouter model id when the option doesn't name one (default Whisper large v3). */
  model?: string;
}

/** 16-bit mono PCM at RATE as a WAV file. */
export function pcmToWav(pcm: Buffer, rate = RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

interface VerboseWord { word?: unknown; start?: unknown; end?: unknown }

export function createOpenRouterStt(deps: OpenRouterSttDeps = {}): OpenScribe {
  return async ({ language, model: option }) => {
    const model = (option && STT_OPENROUTER_MODEL[option]) || deps.model || WHISPER_MODEL;
    const apiKey = deps.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
    const doFetch = deps.fetch ?? fetch;
    const timeoutMs = deps.timeoutMs ?? 30_000;
    const chunks: Buffer[] = [];
    let bytes = 0;
    let committed = false;
    let closed = false;
    const abort = new AbortController();
    let resolveFinal!: (r: { text: string; words: Word[]; language?: string }) => void;
    let rejectFinal!: (e: Error) => void;
    const finalP = new Promise<{ text: string; words: Word[]; language?: string }>((res, rej) => { resolveFinal = res; rejectFinal = rej; });
    finalP.catch(() => {}); // callers observe the rejection where it matters

    const transcribe = async (pcm: Buffer) => {
      const res = await doFetch(OPENROUTER_STT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          input_audio: { data: pcmToWav(pcm).toString("base64"), format: "wav" },
          response_format: "verbose_json",
          timestamp_granularities: ["word"],
          ...(language ? { language } : {}),
        }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (!res.ok) throw new Error(`OpenRouter STT ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      const j = (await res.json()) as { text?: unknown; language?: unknown; words?: unknown };
      const words = Array.isArray(j.words)
        ? (j.words as VerboseWord[])
          .filter((w) => w && typeof w.word === "string")
          .map((w) => ({ text: (w.word as string).trim(), start: Number(w.start), end: Number(w.end) })) // Whisper's words carry a leading space
        : [];
      return { text: typeof j.text === "string" ? j.text.trim() : "", words, ...(typeof j.language === "string" ? { language: j.language } : {}) };
    };

    const stream: SttStream = {
      pushAudio(pcm24k: Buffer) {
        if (committed || closed || pcm24k.length === 0) return; // audio after release is ignored
        chunks.push(pcm24k);
        bytes += pcm24k.length;
      },
      commit() {
        if (committed || closed) return;
        committed = true;
        const pcm = Buffer.concat(chunks.splice(0));
        if (!pcm.length) return resolveFinal({ text: "", words: [] });
        transcribe(pcm).then(resolveFinal, rejectFinal);
      },
      onPartial() {
        // No partials: the batch endpoint returns only the finished transcript.
      },
      final: () => finalP,
      close() {
        if (closed) return;
        closed = true;
        abort.abort();
        rejectFinal(new Error("openRouterStt: closed before final"));
      },
      get seconds() {
        return bytes / BYTES_PER_SEC;
      },
    };
    return stream;
  };
}

export const openOpenRouterStt: OpenScribe = createOpenRouterStt();
