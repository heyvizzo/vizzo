// The API keys and speech settings. The Settings window edits them; they are stored in the app's settings file
// (not the repo) and handed to the voice server. A shell variable already set wins for `npm run dev`.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keychainCipher, keychainService, openEnv, type Cipher, type StoredEnv } from "./secrets.ts";

export interface EnvField {
  key: string;
  label: string;
  secret: boolean;
  hint: string;
  /** A speech model's setting, not a key: Settings shows it next to its model (or not at all), not under API keys. */
  param?: boolean;
}

/** Fields the Settings window shows, in order. */
export const ENV_FIELDS: EnvField[] = [
  { key: "OPENROUTER_API_KEY", label: "OpenRouter API key", secret: true, hint: "Fish Audio, Whisper, and the OpenRouter API on the Fast tier." },
  { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", secret: true, hint: "The Anthropic API on the Fast tier." },
  { key: "OPENAI_API_KEY", label: "OpenAI API key", secret: true, hint: "OpenAI tts-1 speech, and the OpenAI API on the Fast tier." },
  { key: "CEREBRAS_API_KEY", label: "Cerebras API key", secret: true, hint: "The Cerebras API on the Fast tier (and Cerebras models in opencode, Pi, OhMyPi)." },
  { key: "FIREWORKS_API_KEY", label: "Fireworks API key", secret: true, hint: "The Fireworks API on the Fast tier (and Fireworks models in opencode, Pi, OhMyPi)." },
  { key: "ZAI_API_KEY", label: "Z.ai API key", secret: true, hint: "The Z.ai (GLM) API on the Fast tier." },
  { key: "ELEVENLABS_API_KEY", label: "ElevenLabs API key", secret: true, hint: "Scribe transcription and ElevenLabs speech." },
  { key: "ELEVENLABS_VOICE_ID", label: "ElevenLabs voice ID", secret: false, hint: "The voice used for ElevenLabs speech.", param: true },
  { key: "FISH_VOICE_ID", label: "Fish Audio voice ID", secret: false, hint: "Optional Drama 3 voice. Empty lets the model choose.", param: true },
  { key: "FISH_DIRECTION", label: "Fish Audio direction", secret: false, hint: "Tone for every sentence, such as calm or warm. Empty lets the model decide.", param: true },
];

const ENV_KEYS = new Set(ENV_FIELDS.map((field) => field.key));
/** The API keys: saved encrypted (electron/secrets.ts). */
export const SECRET_KEYS = ENV_FIELDS.filter((field) => field.secret).map((field) => field.key);

/** The unpackaged app's name (package.json): its settings folder and its Keychain entry are named after it. */
const DEV_APP_NAME = "realtime-voice-latency-lab";

/** Unpackaged Electron stores this under ~/Library/Application Support/. `npm run dev` reads the same file. */
export function desktopSettingsPath(): string {
  return join(homedir(), "Library", "Application Support", DEV_APP_NAME, "settings.json");
}

/** Keeps only known settings keys. Blank strings clear a key. */
export function sanitizeEnv(input: unknown): Record<string, string> {
  const source = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const out: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = source[key];
    if (typeof value !== "string") continue;
    out[key] = value.trim();
  }
  return out;
}

/** Writes the stored keys onto `process.env`. A blank value removes a known key. */
export function applyEnv(env: Record<string, string>, target: NodeJS.ProcessEnv = process.env): void {
  const clean = sanitizeEnv(env);
  for (const key of ENV_KEYS) {
    const value = clean[key] ?? "";
    if (value) target[key] = value;
    else delete target[key];
  }
}

/** Fills any key the process does not already have from the desktop settings file. */
export function loadDesktopEnv(target: NodeJS.ProcessEnv = process.env, file = desktopSettingsPath(), cipher?: Cipher): void {
  if (process.platform !== "darwin") return;
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return;
  let stored: StoredEnv;
  try {
    stored = JSON.parse(readFileSync(file, "utf8")) as StoredEnv;
  } catch {
    return;
  }
  // The API keys are encrypted: only ask the Keychain (macOS shows a password prompt) for ones the shell lacks.
  const needed = Object.keys(stored.secrets ?? {}).filter((key) => !target[key]);
  const opened = openEnv({ env: stored.env, secrets: Object.fromEntries(needed.map((k) => [k, stored.secrets![k]!])) }, SECRET_KEYS,
    needed.length ? cipher ?? keychainCipher(DEV_APP_NAME) : null);
  if (opened.unreadable.length) {
    console.warn(`[settings] couldn't decrypt ${opened.unreadable.join(", ")} from the Keychain ("${keychainService(DEV_APP_NAME).service}"): set them in the shell or .env`);
  }
  const clean = sanitizeEnv(opened.env);
  for (const key of ENV_KEYS) {
    if (target[key] || !clean[key]) continue;
    target[key] = clean[key];
  }
}
