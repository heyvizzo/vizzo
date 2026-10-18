// Voices the Chat page can offer per TTS model: Piper's (the installed ones from .models/piper/*.onnx.json, then the
// rest of PIPER_CATALOG, which Settings downloads when picked), a curated set of Kokoro voices (all in Kokoro's one
// voices file), and OpenAI tts-1's voices. Served at GET /api/tts/voices.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { TTS1_VOICES } from "./adapters/openaiTts.ts";
import { SPEECH_ROOT } from "./paths.ts";

const PIPER_DIR = `${SPEECH_ROOT}.models/piper/`;

export interface VoiceOption {
  id: string; label: string; lang: string; default?: boolean;
  /** Piper: false for a catalog voice that isn't downloaded yet (`bytes`: its size). */
  installed?: boolean; bytes?: number;
}

/**
 * Piper voices Settings offers. Installing Piper downloads PIPER_BASE (English + Piper's only Romanian voice); the
 * others download when picked (scripts/setup-local-tts.sh piper/<id>). High quality is the least robotic, ~2x the size.
 */
export const PIPER_BASE = ["en_US-lessac-medium", "ro_RO-mihai-medium"];
export const PIPER_CATALOG: { id: string; bytes: number }[] = [
  { id: "en_US-lessac-medium", bytes: 63_201_294 }, { id: "ro_RO-mihai-medium", bytes: 63_201_294 },
  { id: "en_US-lessac-high", bytes: 113_895_201 }, { id: "en_US-ryan-high", bytes: 120_786_792 },
  { id: "en_US-ljspeech-high", bytes: 114_199_011 }, { id: "en_GB-cori-high", bytes: 114_219_352 },
  { id: "en_US-amy-medium", bytes: 63_201_294 }, { id: "en_US-hfc_female-medium", bytes: 63_201_294 },
  { id: "en_US-hfc_male-medium", bytes: 63_201_294 }, { id: "en_GB-alba-medium", bytes: 63_201_294 },
  { id: "en_GB-jenny_dioco-medium", bytes: 63_201_294 }, { id: "en_US-libritts_r-medium", bytes: 78_580_914 },
];
export const isPiperCatalogVoice = (id: string): boolean => PIPER_CATALOG.some((v) => v.id === id);

const QUALITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, x_low: 3 };

/** "en_US-ryan-high" → its label and sort rank (English first, then by quality). */
function piperOption(id: string, speakers = 1): VoiceOption & { rank: number } {
  const [lang = "", name = id, quality = ""] = id.split("-");
  const country = lang.split("_")[1] ?? "";
  return {
    id, lang: lang.replace("_", "-"),
    label: `${name.replace(/_/g, " ")} (${country}, ${quality}${speakers > 1 ? `, ${speakers} speakers` : ""})`,
    rank: (lang.startsWith("ro") ? 10 : 0) + (QUALITY_RANK[quality] ?? 5),
  };
}

/** Installed Piper voices, then (once Piper itself is installed) the catalog's others, to download when picked. */
export function piperVoices(dir = PIPER_DIR): VoiceOption[] {
  if (!existsSync(dir)) return [];
  const out: (VoiceOption & { rank: number })[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".onnx.json"))) {
    const id = f.replace(/\.onnx\.json$/, "");
    if (!existsSync(`${dir}${id}.onnx`)) continue;
    let meta: { num_speakers?: number } = {};
    try { meta = JSON.parse(readFileSync(`${dir}${f}`, "utf8")); } catch { /* keep defaults */ }
    out.push({ ...piperOption(id, meta.num_speakers ?? 1), installed: true });
  }
  const sorted = (list: typeof out) => list.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  const installed = sorted(out);
  const base = PIPER_BASE.every((id) => installed.some((v) => v.id === id));
  const more = base ? sorted(PIPER_CATALOG.filter((c) => !installed.some((v) => v.id === c.id)).map((c) => ({ ...piperOption(c.id), installed: false, bytes: c.bytes }))) : [];
  // The default: the best English voice there is (what tools/localtts/server.py picks without a choice).
  const def = installed.find((v) => v.id === "en_US-lessac-high") ?? installed.find((v) => v.id === "en_US-lessac-medium");
  return [...installed, ...more].map(({ rank: _rank, ...v }) => (v.id === def?.id ? { ...v, default: true } : v));
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
