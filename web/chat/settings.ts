// The chat's settings, kept in the app's settings file (electron/main.ts `chat`). Two windows edit them: the Settings
// window (web/settings/main.ts) owns PANEL_KEYS, the chat sidebar (web/chat/main.ts) SIDEBAR_KEYS. Each saves only
// its own keys; main merges them into the file and passes the result to the sidebar.
import { DEFAULT_CONFIG, DEFAULT_TTS_STYLE, validTaskTimeout, FISH_DEFAULT_VOICE, LLM_PROVIDER_LABELS, SELECTION_VERSION, STT_LANGUAGE_SUPPORT, llmOf, migrateChoice, sttLanguagesFor, type LlmChoice, type LlmProvider, type LlmTier, type RouterMode, type RunConfig, type SttModel, type TtsModel, type TtsStyle } from "../../shared/config.ts";
import { parsePointingWords } from "../../shared/languages.ts";
import type { OrbPos } from "../cursor/pageBridge.ts";
import { DEFAULT_HOTKEYS, normalizeHotkeys, type Hotkeys } from "../../shared/hotkeys.ts";
import { clampHangMs, VAD_HANG_MS } from "../audio/vad.ts";
import { DEFAULT_LISTEN_RMS, clampThreshold } from "./meter.ts";

const STORE_KEY = "chat.settings.v1";
/** The long-task threshold (Settings → Models → Turns): whole seconds in this range. */
export const LONG_TASK_MIN = 5;
export const LONG_TASK_MAX = 600;
export const validLongTask = (s: unknown): s is number => Number.isInteger(s) && (s as number) >= LONG_TASK_MIN && (s as number) <= LONG_TASK_MAX;

export interface Settings {
  routerMode: RouterMode; ttsModel: TtsModel; sttModel: SttModel; longTaskSeconds: number;
  /**
   * The languages spoken with each speech-to-text model (its picker in Settings): none = Auto, for a model that says
   * which language it heard. A model without an entry gets its default (sttLanguages).
   */
  sttLanguages: Partial<Record<SttModel, string[]>>;
  /** The pointing-word lists the user edited, by language code: the textarea's text. A language left out uses its starting list. */
  pointingWords: Record<string, string>;
  /** From before the per-model pickers ("auto" | "en" | "ro"): what a model without a selection starts from. */
  language?: string;
  /** How long (minutes) a task or a thread's run may take before it is stopped. */
  taskTimeoutMinutes: number;
  /** Harness or API + model per tier (fast: router and progress lines; smart: hard questions and tasks). */
  llm: Record<LlmTier, LlmChoice>;
  /** The choice last used with each harness, per tier (restored when switching back to that harness). */
  llmModels: Record<LlmTier, Partial<Record<LlmProvider, LlmChoice>>>;
  /** shared/config.ts SELECTION_VERSION the choices were saved under (older: moved over once, see normalizeSettings). */
  selectionVersion?: number;
  /** Debugging: save every model call to the local trace log (server/traceStore.ts). */
  captureTrace: boolean;
  /** Chosen voice per TTS model (Piper / Kokoro / OpenAI). */
  ttsVoices: Partial<Record<TtsModel, string>>;
  /** Open a turn from the mic level instead of holding the talk key. */
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
  /** The keyboard shortcuts (shared/hotkeys.ts); main reads them from here too. */
  hotkeys: Hotkeys;
}

/** What the Settings window changes. */
export const PANEL_KEYS = [
  "routerMode", "ttsModel", "sttModel", "longTaskSeconds", "taskTimeoutMinutes", "sttLanguages", "pointingWords", "llm", "llmModels", "ttsVoices", "ttsStyle",
  "debugOutlines", "hoverOutline", "showRam", "showCost", "showDebug", "captureTrace", "hotkeys", "selectionVersion",
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
    sttLanguages: {}, pointingWords: {}, llm: { ...DEFAULT_CONFIG.llm }, llmModels: { fast: {}, smart: {} }, ttsVoices: {}, alwaysListen: false, listenThreshold: DEFAULT_LISTEN_RMS, listenHangMs: VAD_HANG_MS,
    ttsStyle: { ...DEFAULT_TTS_STYLE }, instant: true, debugOutlines: false, hoverOutline: false, showRam: false, showCost: false, showDebug: false, captureTrace: false, orbPos: null, hotkeys: DEFAULT_HOTKEYS,
  };
  if (saved && typeof saved === "object") Object.assign(settings, saved);
  settings.ttsStyle = { ...DEFAULT_TTS_STYLE, ...settings.ttsStyle };
  if (!validLongTask(settings.longTaskSeconds)) settings.longTaskSeconds = 20;
  if (!validTaskTimeout(settings.taskTimeoutMinutes)) settings.taskTimeoutMinutes = DEFAULT_CONFIG.taskTimeoutMinutes;
  if (typeof settings.language !== "string") delete settings.language;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
  settings.sttLanguages = Object.fromEntries(
    Object.entries(settings.sttLanguages && typeof settings.sttLanguages === "object" ? settings.sttLanguages : {})
      .filter(([model, v]) => model in STT_LANGUAGE_SUPPORT && strings(v)),
  );
  settings.pointingWords = Object.fromEntries(
    Object.entries(settings.pointingWords && typeof settings.pointingWords === "object" ? settings.pointingWords : {})
      .filter(([, v]) => typeof v === "string"),
  );
  // Saved before tiers (claudeBackend) or naming a removed API provider: the defaults. The server's saved
  // selection (GET /api/llm/selection) replaces this.
  settings.llm = llmOf({ llm: settings.llm });
  delete (settings as { claudeBackend?: string }).claudeBackend;
  // Saved when the sidebar could switch approach (A/B/C): only the pipeline is left.
  delete (settings as { approach?: string }).approach;
  delete (settings as { realtimeModel?: string }).realtimeModel;
  const keepChoices = (m: Partial<Record<string, unknown>> | undefined) =>
    Object.fromEntries(Object.entries(m ?? {}).filter(([k, v]) => k in LLM_PROVIDER_LABELS && typeof v === "object" && v)) as Partial<Record<LlmProvider, LlmChoice>>;
  settings.llmModels = { fast: keepChoices(settings.llmModels?.fast), smart: keepChoices(settings.llmModels?.smart) };
  // Saved before the solver's switches started on: the remembered smart-tier choices lose their old switches once,
  // as the server's saved selection does (server/llmSelection.ts).
  if ((settings.selectionVersion ?? 1) < SELECTION_VERSION) {
    settings.llmModels.smart = Object.fromEntries(Object.entries(settings.llmModels.smart).map(([k, c]) => [k, migrateChoice("smart", c!)]));
    settings.selectionVersion = SELECTION_VERSION;
  }
  settings.alwaysListen = settings.alwaysListen === true;
  settings.instant = settings.instant !== false;
  settings.debugOutlines = settings.debugOutlines === true;
  settings.hoverOutline = settings.hoverOutline === true;
  settings.showRam = settings.showRam === true;
  settings.showCost = settings.showCost === true;
  settings.showDebug = settings.showDebug === true;
  settings.captureTrace = settings.captureTrace === true;
  const o = settings.orbPos;
  settings.orbPos = o && Number.isFinite(o.x) && Number.isFinite(o.y) ? { x: Math.min(1, Math.max(0, o.x)), y: Math.min(1, Math.max(0, o.y)) } : null;
  settings.listenThreshold = clampThreshold(settings.listenThreshold);
  settings.listenHangMs = clampHangMs(settings.listenHangMs);
  settings.hotkeys = normalizeHotkeys(settings.hotkeys);
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

/** The languages spoken with a speech-to-text model (default: the selected one): its picker's value, made valid. [] = Auto. */
export function sttLanguages(settings: Pick<Settings, "sttModel" | "sttLanguages" | "language">, model: SttModel = settings.sttModel): string[] {
  return sttLanguagesFor(model, settings.sttLanguages[model], settings.language);
}

/**
 * A turn's language settings: the speech engine is pinned when one language is chosen, the chosen languages' pointing
 * words are used together, and the lists the user edited go along.
 */
export function languageConfig(settings: Pick<Settings, "sttModel" | "sttLanguages" | "language" | "pointingWords">): Pick<RunConfig, "language" | "languages" | "pointingWords"> {
  const languages = sttLanguages(settings);
  const edited = Object.entries(settings.pointingWords);
  return {
    language: languages.length === 1 ? languages[0]! : "auto",
    languages,
    ...(edited.length ? { pointingWords: Object.fromEntries(edited.map(([code, text]) => [code, parsePointingWords(text)])) } : {}),
  };
}
