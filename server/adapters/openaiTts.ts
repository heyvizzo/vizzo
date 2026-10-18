// OpenAI text-to-speech (`tts-1`, "optimized for realtime text-to-speech") behind the TtsStream interface.
// POST /v1/audio/speech with response_format "pcm" returns raw 24 kHz 16-bit signed little-endian mono —
// the lab's audio format — streamed with chunked transfer encoding (sentence pipeline: sentenceTts.ts).
// Price: $15 per 1M characters (docs/API-NOTES.md).
import type { OpenTts } from "./types.ts";
import { openSentenceTts } from "./sentenceTts.ts";

export const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";
/** Voices tts-1 supports (the guide lists these for tts-1 / tts-1-hd); voices are optimized for English. */
export const TTS1_VOICES = ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"] as const;
const DEFAULT_VOICE = "coral";

export interface OpenAiTtsDeps {
  fetch?: typeof fetch;
  apiKey?: string;
  voice?: string;
}

export function createOpenAiTts(deps: OpenAiTtsDeps = {}): OpenTts {
  return async ({ mark, segment, model, voice: requested }) => {
    const apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");
    const valid = (v?: string) => (v && (TTS1_VOICES as readonly string[]).includes(v) ? v : undefined);
    const voice = valid(requested) ?? deps.voice ?? process.env.OPENAI_TTS_VOICE ?? DEFAULT_VOICE;
    const doFetch = deps.fetch ?? fetch;
    const apiModel = model === "openai_tts_1" ? "tts-1" : model;
    return openSentenceTts({
      mark, segment, markMeta: { model: apiModel, voice },
      fetchPcm: async (text) => {
        const res = await doFetch(OPENAI_TTS_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: apiModel, input: text, voice, response_format: "pcm" }),
        });
        if (!res.ok || !res.body) throw new Error(`OpenAI TTS ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
        return res.body as unknown as AsyncIterable<Uint8Array>;
      },
    });
  };
}

export const openOpenAiTts: OpenTts = createOpenAiTts();
