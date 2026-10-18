// What Settings lists under Speech to text and Text to speech: every model, grouped API / On-device, and what each row
// says (a missing API key or voice ID, the language it won't follow, the engine loading) and offers (Install,
// Cancel, Uninstall). No DOM here: web/settings/speechView.ts draws it.
import { STT_API_KEYS, TTS_API_KEYS, type SpeechLanguage, type SttModel, type TtsModel } from "../../shared/config.ts";
import type { EngineState, InstallState } from "../../shared/protocol.ts";
import { engineStatus, fmtBytes, sttLanguageWarning } from "../chat/logic.ts";

export type SpeechKind = "stt" | "tts";

export interface ModelRow {
  kind: SpeechKind;
  id: SttModel | TtsModel;
  group: "api" | "device";
  name: string;
  /** Who runs it (API) or what it runs on. */
  vendor: string;
  desc: string;
  /** On-device: the engine id the server installs and runs ("parakeet"). */
  engine?: string;
  /** API: the key it needs (an ENV_FIELDS key). */
  apiKey?: string;
}

const stt = (id: SttModel, group: ModelRow["group"], name: string, vendor: string, desc: string): ModelRow => ({
  kind: "stt", id, group, name, vendor, desc,
  ...(group === "device" ? { engine: id.slice("local_".length) } : { apiKey: STT_API_KEYS[id] }),
});
const tts = (id: TtsModel, group: ModelRow["group"], name: string, vendor: string, desc: string): ModelRow => ({
  kind: "tts", id, group, name, vendor, desc, ...(group === "device" ? { engine: id } : { apiKey: TTS_API_KEYS[id] }),
});

export const STT_ROWS: readonly ModelRow[] = [
  stt("scribe_v2", "api", "Scribe v2 Realtime", "ElevenLabs", "Streams while you talk. English and Romanian."),
  stt("openrouter_whisper_large_v3", "api", "Whisper large v3", "OpenRouter", "Gets the whole clip on release."),
  stt("openrouter_fish_transcribe_1", "api", "Fish Audio Transcribe 1", "OpenRouter", "Gets the whole clip on release."),
  stt("openrouter_nemotron_asr", "api", "Nemotron 3.5 ASR", "OpenRouter", "Gets the whole clip on release."),
  stt("local_parakeet", "device", "Parakeet TDT 0.6B v3", "MLX", "Re-transcribes while you talk. 25 European languages, Romanian included."),
  stt("local_apple", "device", "Apple SpeechTranscriber", "macOS", "Streams while you talk. English. macOS downloads its model on first use."),
  stt("local_whisperkit", "device", "WhisperKit large-v3 turbo", "Core ML", "Gets the whole clip on release. Installs whisperkit-cli with Homebrew; the first load compiles the model (a few minutes)."),
  stt("local_moonshine", "device", "Moonshine medium", "ONNX", "Re-transcribes while you talk. English only."),
];

export const TTS_ROWS: readonly ModelRow[] = [
  tts("eleven_v4_turbo", "api", "ElevenLabs v4 Turbo", "ElevenLabs", "Streams sentence by sentence."),
  tts("eleven_flash_v2_5", "api", "ElevenLabs Flash v2.5", "ElevenLabs", "The lowest-latency ElevenLabs model."),
  tts("openai_tts_1", "api", "OpenAI tts-1", "OpenAI", "One request per sentence."),
  tts("fish_drama_3", "api", "Fish Audio Drama 3", "OpenRouter", "Direction is said before each sentence in brackets, not spoken."),
  tts("macos", "device", "macOS voices", "AVSpeechSynthesizer", "The system's own voices."),
  tts("kokoro", "device", "Kokoro-82M", "ONNX", "English voices; Romanian uses an Italian voice."),
  tts("piper", "device", "Piper", "ONNX", "English voices; Romanian uses mihai."),
];

export interface RowContext {
  selected: boolean;
  /** The saved API keys and voice IDs (blank or missing: not set). */
  env: Record<string, string>;
  language: SpeechLanguage;
  /** Undefined while the voice server isn't running (no project folder yet). */
  install?: InstallState;
  engines: readonly EngineState[];
  /** The selection was just sent and the server hasn't listed the engine yet. */
  pending: boolean;
}

/** A line under the model's name. `focus`: what clicking it moves the focus to (an env key's field). */
export interface RowNote {
  tone: "error" | "warn" | "muted" | "ok" | "loading";
  text: string;
  focus?: string;
}

/** Everything that needs saying under a row's name, most important first. */
export function rowNotes(row: ModelRow, ctx: RowContext, keyLabel: (key: string) => string): RowNote[] {
  const notes: RowNote[] = [];
  if (row.apiKey && !ctx.env[row.apiKey]?.trim()) {
    notes.push({ tone: "error", text: `${keyLabel(row.apiKey)} is missing. Add it under API keys.`, focus: row.apiKey });
  }
  if (row.id.startsWith("eleven_") && !ctx.env.ELEVENLABS_VOICE_ID?.trim()) {
    notes.push({ tone: "error", text: "Needs a voice ID.", focus: "ELEVENLABS_VOICE_ID" });
  }
  const install = ctx.install;
  // What the install is doing, in full (the install column only has room for the percentage).
  if (install?.state === "installing" && install.phase) notes.push({ tone: "loading", text: install.phase });
  if (install?.state === "error") notes.push({ tone: "error", text: `Install failed: ${install.error ?? "unknown error"}` });
  else if (ctx.selected && install && !install.installed && install.state === "idle") {
    notes.push({ tone: "error", text: "Not installed: install it, or pick another model." });
  }
  if (row.kind === "stt") {
    const why = sttLanguageWarning(row.id as SttModel, ctx.language);
    if (why) notes.push({ tone: "warn", text: why });
  }
  if (ctx.selected && row.engine && (!install || install.installed)) {
    const s = engineStatus(row.engine, row.kind, ctx.engines, ctx.pending);
    if (s && s.state !== "idle") notes.push({ tone: s.state === "ready" ? "ok" : s.state === "error" ? "error" : "loading", text: s.text });
  }
  return notes;
}

/** The row's install control: its button and the text beside it (on-device rows only). */
export interface InstallView {
  button?: "install" | "cancel" | "uninstall";
  text: string;
  /** 0–1 while downloading. */
  progress?: number;
  /** Installing, but not in a way that can be measured (setting up Python, compiling): a busy bar. */
  busy?: boolean;
}

export function installView(row: ModelRow, install: InstallState | undefined): InstallView | null {
  if (row.group !== "device") return null;
  if (!install) return { text: "Choose a project folder to start the voice server." };
  if (install.builtin) return { text: "Built into macOS" };
  if (install.state === "queued") return { button: "cancel", text: "Waiting for another install…" };
  if (install.state === "installing") {
    if (install.progress === undefined) return { button: "cancel", text: "Working…", busy: true };
    const of = install.totalBytes ? ` of ${fmtBytes(install.totalBytes)}` : "";
    return { button: "cancel", text: `${Math.round(install.progress * 100)}%${of}`, progress: install.progress };
  }
  if (install.installed) return { button: "uninstall", text: install.diskBytes ? fmtBytes(install.diskBytes) : "Installed" };
  return { button: "install", text: install.downloadBytes ? `${fmtBytes(install.downloadBytes)} download` : "Not installed" };
}

/** A model can be picked unless it's on-device and not installed (the current pick stays, so it shows as selected). */
export function canSelect(row: ModelRow, install: InstallState | undefined, selected: boolean): boolean {
  return selected || row.group === "api" || !install || install.installed;
}

/** Lines for the voices an engine is downloading (a picked Piper voice that wasn't there). */
export function voiceNotes(install: InstallState | undefined, labelOf: (voice: string) => string): RowNote[] {
  return (install?.voices ?? []).map((v) => {
    const name = labelOf(v.voice);
    if (v.state === "error") return { tone: "error", text: `Couldn't download ${name}: ${v.error ?? "unknown error"}` };
    if (v.state === "queued") return { tone: "loading", text: `Waiting to download ${name}…` };
    const pct = v.progress !== undefined ? ` · ${Math.round(v.progress * 100)}%` : "";
    return { tone: "loading", text: `Downloading ${name}${pct}. It's used once it's here.` };
  });
}
