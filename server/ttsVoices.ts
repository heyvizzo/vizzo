// Voices the Chat page can offer per TTS model: installed Piper voices (from .models/piper/*.onnx.json),
// a curated set of Kokoro voices, and OpenAI tts-1's voices. Served at GET /api/tts/voices.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TTS1_VOICES } from "./adapters/openaiTts.ts";

const PIPER_DIR = fileURLToPath(new URL("../.models/piper/", import.meta.url));

export interface VoiceOption { id: string; label: string; lang: string; default?: boolean }

const QUALITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, x_low: 3 };

export function piperVoices(dir = PIPER_DIR): VoiceOption[] {
  if (!existsSync(dir)) return [];
  const out: (VoiceOption & { rank: number })[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".onnx.json"))) {
    const id = f.replace(/\.onnx\.json$/, "");
    if (!existsSync(`${dir}${id}.onnx`)) continue;
    let meta: { language?: { code?: string; name_english?: string; country_english?: string }; audio?: { quality?: string }; num_speakers?: number } = {};
    try { meta = JSON.parse(readFileSync(`${dir}${f}`, "utf8")); } catch { /* keep defaults */ }
    const [lang = "", name = id, quality = meta.audio?.quality ?? ""] = id.split("-");
    const country = lang.split("_")[1] ?? "";
    const speakers = (meta.num_speakers ?? 1) > 1 ? `, ${meta.num_speakers} speakers` : "";
    out.push({
      id, lang: lang.replace("_", "-"),
      label: `${name.replace(/_/g, " ")} (${country}, ${quality}${speakers})`,
      rank: (lang.startsWith("ro") ? 10 : 0) + (QUALITY_RANK[quality] ?? 5),
      ...(id === "en_US-lessac-high" ? { default: true } : {}),
    });
  }
  return out.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label)).map(({ rank: _rank, ...v }) => v);
}

/** Kokoro-82M English voices worth offering (all live in voices-v1.0.bin). */
export const KOKORO_VOICES: VoiceOption[] = [
  { id: "af_heart", label: "Heart (US female)", lang: "en-US", default: true },
  { id: "af_bella", label: "Bella (US female)", lang: "en-US" },
  { id: "af_nicole", label: "Nicole (US female, soft)", lang: "en-US" },
  { id: "am_michael", label: "Michael (US male)", lang: "en-US" },
  { id: "am_fenrir", label: "Fenrir (US male)", lang: "en-US" },
  { id: "bf_emma", label: "Emma (UK female)", lang: "en-GB" },
  { id: "bm_george", label: "George (UK male)", lang: "en-GB" },
];

export function ttsVoices(): Record<string, VoiceOption[]> {
  return {
    piper: piperVoices(),
    kokoro: KOKORO_VOICES,
    openai_tts_1: TTS1_VOICES.map((v) => ({ id: v, label: v, lang: "en", ...(v === "coral" ? { default: true } : {}) })),
  };
}
