// Which on-device speech engines run: only the selected Voice (TTS) and Speech (STT) models, when they're local ones.
// Picking another in Settings (POST /api/speech/selection) kills the old engine's helper and starts the new one; the
// selection is saved so the next start loads the same models before the first turn. The chat sidebar sends it too
// when it loads, in case the file is missing or out of date. GET /api/speech/engines: their state and RAM.
// File: $SPEECH_SELECTION_FILE, default ~/.config/vizzo/speech-selection.json.
// LOCAL_TTS=0 / LOCAL_STT=0 keep them from starting ahead of a turn (a turn still starts the one it needs).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, isLocalStt, isLocalTts, STT_LABELS, TTS_LABELS, type SttModel, type TtsModel } from "../shared/config.ts";
import type { EngineState } from "../shared/protocol.ts";
import { LOCAL_ENGINES, localTtsStates, startLocalTts, stopLocalTts, type LocalEngine } from "./adapters/localTts.ts";
import { LOCAL_STT_ENGINES, localSttStates, startLocalStt, stopLocalStt, type LocalSttEngine } from "./adapters/localStt.ts";

export interface SpeechSelection { tts: TtsModel; stt: SttModel }

const file = (): string => process.env.SPEECH_SELECTION_FILE ?? join(homedir(), ".config", "vizzo", "speech-selection.json");

const enabled = (kind: "tts" | "stt"): boolean =>
  process.platform === "darwin" && process.env.FAKE_VENDORS !== "1" && process.env[kind === "tts" ? "LOCAL_TTS" : "LOCAL_STT"] !== "0";

/** The STT engine id behind a local Speech model ("local_parakeet" → "parakeet"). */
export const sttEngineOf = (m: SttModel): LocalSttEngine | null => (isLocalStt(m) ? (m.slice("local_".length) as LocalSttEngine) : null);
const ttsEngineOf = (m: TtsModel): LocalEngine | null => (isLocalTts(m) ? m : null);

let current: SpeechSelection | null = null;

/** A selection from anywhere (the file, a request) made valid; unknown models → the defaults. */
export function normalizeSelection(v: unknown): SpeechSelection {
  const o = (v && typeof v === "object" ? v : {}) as Partial<Record<"tts" | "stt", unknown>>;
  return {
    tts: typeof o.tts === "string" && o.tts in TTS_LABELS ? (o.tts as TtsModel) : DEFAULT_CONFIG.ttsModel,
    stt: typeof o.stt === "string" && o.stt in STT_LABELS ? (o.stt as SttModel) : DEFAULT_CONFIG.sttModel,
  };
}

/** The saved selection (the defaults if there's none or it can't be read). */
export function currentSpeech(): SpeechSelection {
  if (current) return current;
  try { current = normalizeSelection(JSON.parse(readFileSync(file(), "utf8"))); } catch { current = normalizeSelection({}); }
  return current;
}

/** Run exactly the selection's local engines: the others are killed, the selected ones started. */
function apply(sel: SpeechSelection): void {
  const tts = ttsEngineOf(sel.tts);
  const stt = sttEngineOf(sel.stt);
  for (const e of LOCAL_ENGINES) if (e !== tts) stopLocalTts(e);
  for (const e of LOCAL_STT_ENGINES) if (e !== stt) stopLocalStt(e);
  if (tts && enabled("tts")) startLocalTts(tts).catch(() => {});
  if (stt && enabled("stt")) startLocalStt(stt).catch(() => {});
}

/** Save a new selection and switch the engines to it. */
export function setSpeech(sel: unknown): SpeechSelection {
  const next = normalizeSelection(sel);
  const changed = !current || next.tts !== current.tts || next.stt !== current.stt;
  current = next;
  if (changed) {
    try {
      mkdirSync(dirname(file()), { recursive: true });
      writeFileSync(file(), JSON.stringify(current, null, 2) + "\n");
    } catch (e) {
      console.error(`[speech] couldn't save the selection: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  apply(current);
  return current;
}

/** Server start: load the saved selection's engines. */
export function startSavedSpeech(): void {
  apply(currentSpeech());
}

/** Pids of the engines' helper processes (for MemorySnapshot.speechBytes). */
export function speechEnginePids(): number[] {
  return [...localTtsStates(), ...localSttStates()].flatMap((s) => (s.pid ? [s.pid] : []));
}

/** The engines that are loading, running or failed, with their RAM. */
export async function speechEngineStates(): Promise<EngineState[]> {
  const all = [
    ...localTtsStates().map((s) => ({ ...s, kind: "tts" as const })),
    ...localSttStates().map((s) => ({ ...s, kind: "stt" as const })),
  ];
  const { memoryOf } = await import("./memory.ts");
  const ram = await memoryOf(all.flatMap((s) => (s.pid ? [s.pid] : []))).catch(() => new Map<number, number>());
  return all.map(({ pid, ...s }) => ({ ...s, ...(pid && ram.get(pid) ? { ramBytes: ram.get(pid) } : {}) }));
}
