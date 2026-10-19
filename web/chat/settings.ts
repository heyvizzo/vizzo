// The chat's settings, kept in the app's settings file (electron/main.ts `chat`). Two windows edit them: the Settings
// window (web/settings/main.ts) owns PANEL_KEYS, the chat sidebar (web/chat/main.ts) SIDEBAR_KEYS. Each saves only
// its own keys; main merges them into the file and passes the result to the sidebar.
import { DEFAULT_CONFIG, DEFAULT_TTS_STYLE, validTaskTimeout, FISH_DEFAULT_VOICE, LLM_PROVIDER_LABELS, llmOf, type LlmChoice, type LlmProvider, type LlmTier, type RouterMode, type SpeechLanguage, type SttModel, type TtsModel, type TtsStyle } from "../../shared/config.ts";
import type { OrbPos } from "../cursor/pageBridge.ts";
import { clampHangMs, VAD_HANG_MS } from "../audio/vad.ts";
import { DEFAULT_LISTEN_RMS, clampThreshold } from "./meter.ts";

const STORE_KEY = "chat.settings.v1";
/** The long-task threshold (Settings → Models → Turns): whole seconds in this range. */
export const LONG_TASK_MIN = 5;
export const LONG_TASK_MAX = 600;
export const validLongTask = (s: unknown): s is number => Number.isInteger(s) && (s as number) >= LONG_TASK_MIN && (s as number) <= LONG_TASK_MAX;
export const LANGUAGES: { id: SpeechLanguage; label: string }[] = [
  { id: "auto", label: "Auto (en/ro)" }, { id: "en", label: "English" }, { id: "ro", label: "Română" },
];

export interface Settings {
  routerMode: RouterMode; ttsModel: TtsModel; sttModel: SttModel; longTaskSeconds: number; language: SpeechLanguage;
  /** How long (minutes) a task or a thread's run may take before it is stopped. */
  taskTimeoutMinutes: number;
  /** Harness or API + model per tier (fast: router and progress lines; smart: hard questions and tasks). */
  llm: Record<LlmTier, LlmChoice>;
  /** The choice last used with each harness, per tier (restored when switching back to that harness). */
  llmModels: Record<LlmTier, Partial<Record<LlmProvider, LlmChoice>>>;
  /** Chosen voice per TTS model (Piper / Kokoro / OpenAI). */
  ttsVoices: Partial<Record<TtsModel, string>>;
  /** Open a turn from the mic level instead of holding Shift. */
  alwaysListen: boolean;
  /** Linear RMS of the always-listen line. */
  listenThreshold: number;
  /** Always listen: how long (ms) the level must stay under the line before the turn is sent. */
  listenHangMs: number;
  /** Fish Audio Drama 3 delivery. */
  ttsStyle: TtsStyle;
  /** Run each turn when the user finishes talking (off: queue it until Send in the browser toolbar). */
  instant: boolean;
  /** Debugging: draw each turn's pointing outlines (picked elements, cursor rests) on the page. */
  debugOutlines: boolean;
  /** Outline the element under the pointer on the page all the time, as comment mode does. */
  hoverOutline: boolean;
  /** Show the RAM figures (header total, per thread, per page). */
  showRam: boolean;
  /** Show costs and savings (header total, per turn, per task, per thread). */
  showCost: boolean;
  /** Show each turn's debugging details (decision badges, pointing chips, timings, prompts & responses). */
  showDebug: boolean;
  /** Where the conversation orb was dragged to on the page (fractions of the viewport); null: bottom center. */
  orbPos: OrbPos | null;
}

/** What the Settings window changes. */
export const PANEL_KEYS = [
  "routerMode", "ttsModel", "sttModel", "longTaskSeconds", "taskTimeoutMinutes", "language", "llm", "llmModels", "ttsVoices", "ttsStyle",
  "debugOutlines", "hoverOutline", "showRam", "showCost", "showDebug",
] as const satisfies readonly (keyof Settings)[];
/** What the chat sidebar changes (its talk controls, the toolbar's Instant toggle, the orb on the page). */
export const SIDEBAR_KEYS = ["alwaysListen", "listenThreshold", "listenHangMs", "instant", "orbPos"] as const satisfies readonly (keyof Settings)[];

/** The app's bridge to its settings file (electron/preload.ts `chatSettings`). */
export interface ChatSettingsBridge {
  get(): string | null;
  /** Merges these keys into the saved settings. */
  save(json: string): void;
  /** The sidebar: the Settings window saved (the merged settings). */
  onChanged?(cb: (json: string) => void): void;
}

/** Saved settings (any shape, from any version) made whole and valid. */
export function normalizeSettings(saved: unknown): Settings {
  const settings: Settings = {
    routerMode: "auto", ttsModel: DEFAULT_CONFIG.ttsModel, sttModel: DEFAULT_CONFIG.sttModel, longTaskSeconds: 20,
    taskTimeoutMinutes: DEFAULT_CONFIG.taskTimeoutMinutes,
    language: "auto", llm: { ...DEFAULT_CONFIG.llm }, llmModels: { fast: {}, smart: {} }, ttsVoices: {}, alwaysListen: false, listenThreshold: DEFAULT_LISTEN_RMS, listenHangMs: VAD_HANG_MS,
    ttsStyle: { ...DEFAULT_TTS_STYLE }, instant: true, debugOutlines: false, hoverOutline: false, showRam: true, showCost: true, showDebug: true, orbPos: null,
  };
  if (saved && typeof saved === "object") Object.assign(settings, saved);
  settings.ttsStyle = { ...DEFAULT_TTS_STYLE, ...settings.ttsStyle };
  if (!validLongTask(settings.longTaskSeconds)) settings.longTaskSeconds = 20;
  if (!validTaskTimeout(settings.taskTimeoutMinutes)) settings.taskTimeoutMinutes = DEFAULT_CONFIG.taskTimeoutMinutes;
  if (!LANGUAGES.some((l) => l.id === settings.language)) settings.language = "auto";
  // Saved before tiers (claudeBackend) or naming a removed API provider: the defaults. The server's saved
  // selection (GET /api/llm/selection) replaces this.
  settings.llm = llmOf(settings);
  delete (settings as { claudeBackend?: string }).claudeBackend;
  // Saved when the sidebar could switch approach (A/B/C): only the pipeline is left.
  delete (settings as { approach?: string }).approach;
  delete (settings as { realtimeModel?: string }).realtimeModel;
  const keepChoices = (m: Partial<Record<string, unknown>> | undefined) =>
    Object.fromEntries(Object.entries(m ?? {}).filter(([k, v]) => k in LLM_PROVIDER_LABELS && typeof v === "object" && v)) as Partial<Record<LlmProvider, LlmChoice>>;
  settings.llmModels = { fast: keepChoices(settings.llmModels?.fast), smart: keepChoices(settings.llmModels?.smart) };
  settings.alwaysListen = settings.alwaysListen === true;
  settings.instant = settings.instant !== false;
  settings.debugOutlines = settings.debugOutlines === true;
  settings.hoverOutline = settings.hoverOutline === true;
  settings.showRam = settings.showRam !== false;
  settings.showCost = settings.showCost !== false;
  settings.showDebug = settings.showDebug !== false;
  const o = settings.orbPos;
  settings.orbPos = o && Number.isFinite(o.x) && Number.isFinite(o.y) ? { x: Math.min(1, Math.max(0, o.x)), y: Math.min(1, Math.max(0, o.y)) } : null;
  settings.listenThreshold = clampThreshold(settings.listenThreshold);
  settings.listenHangMs = clampHangMs(settings.listenHangMs);
  return settings;
}

/** The app's settings file first (survives a change of Vite port, which resets localStorage), else localStorage. */
export function loadSettings(bridge: ChatSettingsBridge | undefined): Settings {
  let saved: string | null = null;
  try { saved = bridge?.get() ?? null; } catch { /* no app bridge */ }
  try { saved ??= localStorage.getItem(STORE_KEY); } catch { /* storage unavailable */ }
  try { return normalizeSettings(JSON.parse(saved ?? "{}")); } catch { return normalizeSettings({}); }
}

/** Saves `keys` of `settings` to the app's file (merged there with the other window's), and all of it to localStorage. */
export function saveSettingsKeys(bridge: ChatSettingsBridge | undefined, settings: Settings, keys: readonly (keyof Settings)[]): void {
  const json = JSON.stringify(Object.fromEntries(keys.map((k) => [k, settings[k]])));
  try { bridge?.save(json); } catch { /* no app bridge */ }
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

/** The Drama 3 voice: the Voice ID field's value, or the predefined one. */
export function fishVoice(settings: Settings): string {
  return settings.ttsVoices.fish_drama_3 || FISH_DEFAULT_VOICE;
}
