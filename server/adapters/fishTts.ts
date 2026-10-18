// Fish Audio Drama 3 (`fish-audio/drama-3` on OpenRouter; directed in plain language) behind the TtsStream
// interface. POST https://openrouter.ai/api/v1/audio/speech with response_format "pcm": raw PCM16 mono,
// streamed. OpenRouter returns it at the rate in the Content-Type header (44.1 kHz, `audio/pcm;rate=44100`),
// which is resampled here to the 24 kHz the audio pipeline plays. Sentence pipeline: sentenceTts.ts.
// Price: $2 per 1M characters (generation cost measured via OpenRouter, docs/API-NOTES.md).
// Voice: `voice` (the Chat page's Voice ID, else FISH_VOICE_ID). Without one, every sentence is a separate
// request and Fish picks a voice each time. Delivery (TtsStyle): a direction in square brackets is prepended to
// every sentence (the brackets are not spoken), `speed` is sent to the model, and `volume` scales the PCM.
// Without a style, FISH_DIRECTION is used as the direction.
import type { OpenTts } from "./types.ts";
import type { TtsStyle } from "../../shared/config.ts";
import { openSentenceTts } from "./sentenceTts.ts";
import { createPcm16Resampler } from "./pcmResample.ts";

export const OPENROUTER_SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";
export const DRAMA3_MODEL = "fish-audio/drama-3";
const OUT_RATE = 24000;
const DEFAULT_IN_RATE = 44100;

export interface FishTtsDeps {
  fetch?: typeof fetch;
  apiKey?: string;
  voice?: string;
  /** Drama 3 direction for every sentence, without brackets (FISH_DIRECTION). */
  direction?: string;
}

export function createFishTts(deps: FishTtsDeps = {}): OpenTts {
  return async ({ mark, segment, voice: requested, style }) => {
    const apiKey = deps.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
    // The voice is a provider-specific identifier on OpenRouter; omitted → the model's default voice.
    const voice = requested || deps.voice || process.env.FISH_VOICE_ID || undefined;
    const direction = (style ? style.direction : (deps.direction ?? process.env.FISH_DIRECTION ?? "")).trim();
    const speed = style && style.speed !== 1 ? Math.min(2, Math.max(0.5, style.speed)) : undefined;
    const gain = style ? Math.min(2, Math.max(0, style.volume)) : 1;
    const doFetch = deps.fetch ?? fetch;
    return openSentenceTts({
      mark, segment, markMeta: { model: DRAMA3_MODEL, voice: voice ?? "default" },
      fetchPcm: async (text) => {
        const input = direction ? `[${direction}] ${text}` : text;
        const res = await doFetch(OPENROUTER_SPEECH_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: DRAMA3_MODEL, input, response_format: "pcm", ...(voice ? { voice } : {}), ...(speed ? { speed } : {}) }),
        });
        if (!res.ok || !res.body) throw new Error(`Drama 3 TTS (OpenRouter) ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
        const inRate = Number(/rate=(\d+)/.exec(res.headers.get("content-type") ?? "")?.[1]) || DEFAULT_IN_RATE;
        return scaled(resampled(res.body as unknown as AsyncIterable<Uint8Array>, inRate), gain);
      },
    });
  };
}

async function* resampled(body: AsyncIterable<Uint8Array>, inRate: number): AsyncGenerator<Buffer> {
  const resample = createPcm16Resampler(inRate, OUT_RATE);
  for await (const chunk of body) {
    const out = resample(Buffer.from(chunk));
    if (out.length) yield out;
  }
}

/** Multiplies 16-bit samples by `gain` (clipped to the 16-bit range). */
async function* scaled(src: AsyncIterable<Buffer>, gain: number): AsyncGenerator<Buffer> {
  if (gain === 1) return yield* src;
  for await (const chunk of src) {
    const out = Buffer.alloc(chunk.length);
    for (let i = 0; i + 1 < chunk.length; i += 2) {
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(chunk.readInt16LE(i) * gain))), i);
    }
    yield out;
  }
}

export const openFishTts: OpenTts = createFishTts();
