/** "pipeline" = the voice assistant (Scribe → router → TTS); "cursor-only" = speech-to-text + pointing, no LLM or TTS (dictating into a comment). */
export type Approach = "pipeline" | "cursor-only";
/**
 * ElevenLabs (API), OpenAI tts-1 (API), Fish Audio Drama 3 (API, `drama-3`), or on-device (free): "macos"
 * (AVSpeechSynthesizer, tools/mactts), "kokoro" (Kokoro-82M ONNX) and "piper" (Piper; both via
 * tools/localtts, `npm run setup:local-tts`).
 */
export type TtsModel = "eleven_v4_turbo" | "eleven_flash_v2_5" | "openai_tts_1" | "fish_drama_3" | "macos" | "kokoro" | "piper";
/** On-device TTS models: not billed. */
export const LOCAL_TTS_MODELS = ["macos", "kokoro", "piper"] as const;
export const isLocalTts = (m: TtsModel): m is (typeof LOCAL_TTS_MODELS)[number] => (LOCAL_TTS_MODELS as readonly string[]).includes(m);
export const TTS_LABELS: Record<TtsModel, string> = {
  eleven_v4_turbo: "ElevenLabs v4 Turbo", eleven_flash_v2_5: "ElevenLabs Flash v2.5", openai_tts_1: "OpenAI tts-1",
  fish_drama_3: "Fish Audio Drama 3",
  macos: "macOS TTS", kokoro: "Kokoro", piper: "Piper",
};
/**
 * Speech-to-text for the pipeline and cursor-only approaches. Scribe streams partials while you talk;
 * the OpenRouter models get the whole clip on release (batch) and return word timestamps. The on-device
 * ones (free; server/adapters/localStt.ts, `npm run setup:local-stt`) all return word timestamps too:
 * Apple SpeechTranscriber streams partials, Parakeet and Moonshine re-transcribe the clip while you talk,
 * WhisperKit is batch.
 */
export type SttModel = "scribe_v2" | "openrouter_whisper_large_v3" | "openrouter_fish_transcribe_1" | "openrouter_nemotron_asr"
  | "local_parakeet" | "local_apple" | "local_whisperkit" | "local_moonshine";
export const STT_LABELS: Record<SttModel, string> = {
  scribe_v2: "ElevenLabs Scribe v2 Realtime",
  openrouter_whisper_large_v3: "Whisper large v3 (OpenRouter)",
  openrouter_fish_transcribe_1: "Fish Audio Transcribe 1 (OpenRouter)",
  openrouter_nemotron_asr: "NVIDIA Nemotron 3.5 ASR (OpenRouter)",
  local_parakeet: "Parakeet TDT 0.6B v3 (on-device)",
  local_apple: "Apple SpeechTranscriber (on-device)",
  local_whisperkit: "WhisperKit large-v3 turbo (on-device)",
  local_moonshine: "Moonshine medium (on-device)",
};
/** On-device STT models: not billed. */
export const LOCAL_STT_MODELS = ["local_parakeet", "local_apple", "local_whisperkit", "local_moonshine"] as const;
export const isLocalStt = (m: SttModel): m is (typeof LOCAL_STT_MODELS)[number] => (LOCAL_STT_MODELS as readonly string[]).includes(m);
/** OpenRouter model id behind each OpenRouter STT option. */
export const STT_OPENROUTER_MODEL: Partial<Record<SttModel, string>> = {
  openrouter_whisper_large_v3: "openai/whisper-large-v3",
  openrouter_fish_transcribe_1: "fish-audio/transcribe-1",
  openrouter_nemotron_asr: "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b",
};
/**
 * Pinned languages each STT model actually transcribes in (chat logs, 2026-10-14..17). The pin is sent to all of them,
 * but Fish Transcribe ignores it (Chinese / Macedonian / Italian text with en or ro pinned), and Romanian only comes back
 * right from Scribe (Nemotron returned nothing). On-device (tested with macOS `say` clips, 2026-10-17): Parakeet
 * detects the language itself (25 European ones, Romanian included); Apple has no on-device Romanian model (ro-RO
 * dictation lists it but never installs it); Moonshine is English only; WhisperKit (Whisper) does Romanian, pinned or detected.
 */
export const STT_PINNED_LANGUAGES: Record<SttModel, readonly ("en" | "ro")[]> = {
  scribe_v2: ["en", "ro"],
  openrouter_whisper_large_v3: ["en"],
  openrouter_fish_transcribe_1: [],
  openrouter_nemotron_asr: ["en"],
  local_parakeet: ["en", "ro"],
  local_apple: ["en"],
  local_whisperkit: ["en", "ro"],
  local_moonshine: ["en"],
};
/** The API key each paid speech model needs (electron/settings.ts ENV_FIELDS). The on-device ones need none. */
export const STT_API_KEYS: Partial<Record<SttModel, string>> = {
  scribe_v2: "ELEVENLABS_API_KEY",
  openrouter_whisper_large_v3: "OPENROUTER_API_KEY",
  openrouter_fish_transcribe_1: "OPENROUTER_API_KEY",
  openrouter_nemotron_asr: "OPENROUTER_API_KEY",
};
export const TTS_API_KEYS: Partial<Record<TtsModel, string>> = {
  eleven_v4_turbo: "ELEVENLABS_API_KEY",
  eleven_flash_v2_5: "ELEVENLABS_API_KEY",
  openai_tts_1: "OPENAI_API_KEY",
  fish_drama_3: "OPENROUTER_API_KEY",
};
/** Fish Audio Drama 3 voice model id (sent as OpenRouter `voice`) that the Chat page starts with. */
export const FISH_DEFAULT_VOICE = "933563129e564b19a115bedd57b7406a";
/**
 * How Drama 3 delivers the speech. `direction` goes in square brackets before each sentence (not spoken);
 * `speed` (0.5–2) is sent to the model; `volume` (0–2) scales the audio after synthesis.
 */
export interface TtsStyle { direction: string; speed: number; volume: number }
export const DEFAULT_TTS_STYLE: TtsStyle = { direction: "natural, conversational, warm", speed: 1, volume: 1 };
export type RouterMode = "forced" | "auto";
/**
 * The two model tiers: "fast" runs the router and the progress lines, "smart" runs the solver (hard
 * questions and tasks). Each tier runs on a coding-agent harness (a CLI on its own login or API keys) with a model, and
 * optionally a reasoning level and a speed where that harness + model offers them (server/llmProviders.ts). The fast
 * tier can also call a model API directly (server/adapters/llmApi.ts): no tools, no process, one HTTP request.
 */
export type LlmTier = "fast" | "smart";
export const HARNESSES = ["claude-code", "codex", "grok", "opencode", "pi", "omp"] as const;
export type HarnessId = (typeof HARNESSES)[number];
/** Model APIs the fast tier can call directly, with the key from Settings. */
export const API_PROVIDERS = ["openrouter", "fireworks", "cerebras", "anthropic", "openai", "zai"] as const;
export type ApiProviderId = (typeof API_PROVIDERS)[number];
/** A tier's model source: a harness (either tier) or a model API (fast tier only). */
export type LlmProvider = HarnessId | ApiProviderId;
export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  "claude-code": "Claude Code", codex: "Codex", grok: "Grok", opencode: "opencode", pi: "Pi", omp: "OhMyPi",
  openrouter: "OpenRouter API", fireworks: "Fireworks API", cerebras: "Cerebras API", anthropic: "Anthropic API", openai: "OpenAI API", zai: "Z.ai API",
};
/** The Settings key each model API uses. */
export const API_KEY_ENV: Record<ApiProviderId, string> = {
  openrouter: "OPENROUTER_API_KEY", fireworks: "FIREWORKS_API_KEY", cerebras: "CEREBRAS_API_KEY",
  anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", zai: "ZAI_API_KEY",
};
export const isHarness = (p: string): p is HarnessId => (HARNESSES as readonly string[]).includes(p);
export const isApiProvider = (p: string): p is ApiProviderId => (API_PROVIDERS as readonly string[]).includes(p);
export const isLlmProvider = (p: string): p is LlmProvider => isHarness(p) || isApiProvider(p);
/** "fast": the provider's priority / fast-mode tier (Codex "Fast", Claude Opus fast mode), where offered. */
export type LlmSpeed = "standard" | "fast";
/**
 * One tier's choice. `model` "" = the harness's default model. `level`: reasoning effort / thinking level in the
 * harness's own terms ("low", "high", "max"…); omitted = the harness's default.
 */
export interface LlmChoice { provider: LlmProvider; model: string; level?: string; speed?: LlmSpeed; toggles?: HarnessToggles }
/**
 * What a harness agent may load besides its file tools (Settings: checkboxes under the harness). The ids are shared
 * across harnesses; each harness lists only the ones it can switch (server/adapters/harnesses.ts maps them to its
 * flags, config or environment).
 */
export type HarnessToggleId = "shell" | "web" | "subagents" | "images" | "mcp" | "skills" | "hooks" | "plugins" | "instructions";
/** A tier's switches as chosen; an id left out is at its default. */
export type HarnessToggles = Partial<Record<HarnessToggleId, boolean>>;
export interface HarnessToggle { id: HarnessToggleId; label: string; hint: string; default: boolean }
const toggle = (id: HarnessToggleId, label: string, hint: string, on = false): HarnessToggle => ({ id, label, hint, default: on });
export const HARNESS_TOGGLES: Record<HarnessId, HarnessToggle[]> = {
  "claude-code": [
    toggle("shell", "Shell", "The Bash tool"),
    toggle("web", "Web", "WebSearch and WebFetch"),
    toggle("subagents", "Subagents", "The Agent tool"),
    toggle("mcp", "MCP servers", "Your MCP servers (~/.claude.json, .mcp.json)"),
    toggle("skills", "Skills", "Skills and slash commands"),
    toggle("hooks", "Hooks", "Hooks from your settings and plugins"),
    toggle("plugins", "Plugins", "Your enabled plugins (their skills, agents, hooks and MCP servers)"),
    toggle("instructions", "CLAUDE.md", "CLAUDE.md files and auto memory"),
  ],
  codex: [
    toggle("shell", "Shell", "Codex's shell tool: it reads and searches files with it", true),
    toggle("web", "Web search", "The web_search tool"),
    toggle("subagents", "Subagents", "Multi-agent tools (spawn and message agents)"),
    toggle("images", "Image generation", "The image generation tool"),
    toggle("mcp", "MCP servers", "The MCP servers in ~/.codex/config.toml"),
    toggle("skills", "Skills", "Your skills and Codex's bundled ones"),
    toggle("hooks", "Hooks", "~/.codex/hooks.json and project hooks"),
    toggle("plugins", "Plugins", "Plugins and apps (with their MCP servers), browser and computer use"),
    toggle("instructions", "AGENTS.md", "AGENTS.md project instructions"),
  ],
  grok: [
    toggle("shell", "Shell", "run_terminal_command"),
    toggle("web", "Web", "web_search and web_fetch"),
    toggle("subagents", "Subagents", "spawn_subagent"),
    toggle("mcp", "MCP servers", "Your MCP servers (Grok's and Claude's/Cursor's), reached through search_tool/use_tool"),
    toggle("skills", "Skills", "~/.grok/skills and Claude's/Cursor's skills (Grok's bundled skills, ~/.agents/skills and Claude plugins' skills always load)"),
    toggle("hooks", "Hooks", "~/.grok/hooks and Claude's/Cursor's hooks"),
    toggle("plugins", "Plugins", "Your enabled Grok plugins"),
    toggle("instructions", "Rules", "Claude's/Cursor's rules and CLAUDE.md files"),
  ],
  opencode: [
    toggle("shell", "Shell", "The bash tool"),
    toggle("web", "Web", "webfetch and websearch"),
    toggle("subagents", "Subagents", "The task tool"),
    toggle("skills", "Skills", "The skill tool, with your and Claude's skills"),
    toggle("plugins", "Plugins", "Your plugins (~/.config/opencode/plugins): opencode's hooks"),
    toggle("instructions", "CLAUDE.md", "~/.claude/CLAUDE.md (project AGENTS.md always loads)"),
  ],
  pi: [
    toggle("shell", "Shell", "The bash tool"),
    toggle("skills", "Skills", "Skills discovery"),
    toggle("plugins", "Extensions", "Your extensions (~/.pi/agent/extensions): hooks and custom tools"),
    toggle("instructions", "AGENTS.md", "AGENTS.md and CLAUDE.md files"),
  ],
  omp: [
    toggle("shell", "Shell", "bash and eval (Python, JS)"),
    toggle("web", "Web search", "web_search"),
    toggle("subagents", "Subagents", "The task tool"),
    toggle("skills", "Skills", "Skills discovery"),
    toggle("plugins", "Extensions", "Your extensions (~/.omp/agent/extensions): hooks and custom tools"),
    toggle("instructions", "Rules", "Rules discovery"),
  ],
};
/** Whether `id` is on for `harness` under `toggles` (a toggle the harness doesn't list is off). */
export function toggleOn(harness: HarnessId, toggles: HarnessToggles | undefined, id: HarnessToggleId): boolean {
  const t = HARNESS_TOGGLES[harness].find((x) => x.id === id);
  return t ? (toggles?.[id] ?? t.default) : false;
}
/** `toggles` reduced to the ones `harness` lists that differ from their default (undefined: all at default). */
export function cleanToggles(harness: HarnessId, toggles: HarnessToggles | undefined): HarnessToggles | undefined {
  const out: HarnessToggles = {};
  for (const t of HARNESS_TOGGLES[harness]) if (toggles?.[t.id] !== undefined && toggles[t.id] !== t.default) out[t.id] = toggles[t.id];
  return Object.keys(out).length ? out : undefined;
}
/**
 * What a harness or API offers for one model (GET /api/llm/models). `fastLevel`: the level the fast tier starts
 * with when it isn't the usual lightest pick (an API model that can turn reasoning off starts with it off).
 */
export interface LlmModelInfo { id: string; levels: string[]; defaultLevel?: string; fastLevel?: string; fast: boolean }
/**
 * One harness or API in a scan (POST /api/llm/scan): usable or not (`note`: how to install it, or which key it
 * needs), and its models. `api`: a model API (fast tier only).
 */
export interface HarnessScan { id: LlmProvider; label: string; available: boolean; api?: boolean; note?: string; models: LlmModelInfo[]; error?: string }
/** The model each harness or API starts with, per tier ("" = the harness's default model). APIs have no smart tier. */
export const LLM_DEFAULT_MODELS: Record<LlmProvider, { fast: string; smart?: string }> = {
  "claude-code": { fast: "claude-haiku-5-5", smart: "claude-opus-5-5" },
  codex: { fast: "gpt-6-luna", smart: "gpt-6.1-sol" },
  grok: { fast: "grok-4.7-build-fast", smart: "grok-4.7" },
  opencode: { fast: "cerebras/gpt-oss-120b", smart: "opencode/claude-opus-5-5" },
  pi: { fast: "", smart: "" },
  omp: { fast: "cerebras/gpt-oss-120b", smart: "openai-codex/gpt-6-astra" },
  openrouter: { fast: "openai/gpt-oss-120b" },
  fireworks: { fast: "accounts/fireworks/models/gpt-oss-120b" },
  cerebras: { fast: "gpt-oss-120b" },
  anthropic: { fast: "claude-haiku-5-5" },
  openai: { fast: "gpt-6-luna" },
  zai: { fast: "glm-5.3-flash" },
};
/** The level a tier starts with when the model offers it: the lightest for the router, a middle one for the solver. */
export function defaultLevel(info: LlmModelInfo | undefined, tier: LlmTier): string | undefined {
  if (!info?.levels.length) return undefined;
  if (tier === "fast" && info.fastLevel && info.levels.includes(info.fastLevel)) return info.fastLevel;
  const pref = tier === "fast" ? ["low", "minimal", "medium"] : ["medium", "high"];
  return pref.find((l) => info.levels.includes(l)) ?? info.defaultLevel ?? info.levels[0];
}
/** Spoken language: "auto" lets Scribe detect it (en or ro expected); "en"/"ro" pin it. */
export type SpeechLanguage = "auto" | "en" | "ro";

export interface RunConfig {
  approach: Approach;
  solverFast: boolean;
  routerMode: RouterMode;
  ttsModel: TtsModel;
  /** Speech-to-text model (Scribe or OpenRouter Whisper). */
  sttModel: SttModel;
  /** Open vendor sockets ahead of the turn so setup isn't counted. */
  prewarm: boolean;
  /** Pointing window offsets (ARCHITECTURE §6). */
  preMs: number;
  postMs: number;
  /** Chat mode: keep conversation history across turns on this connection. */
  memory: boolean;
  /** Speak short progress lines while waiting for the solver on short tasks. */
  fillers: boolean;
  /** Run long tasks (estimate > longTaskSeconds) as background jobs and announce the result later. */
  backgroundLongTasks: boolean;
  /** Estimate (seconds) above which a task counts as long. */
  longTaskSeconds: number;
  /** How long (minutes) a solver run (a task, a background job, a thread's run) may take before it is stopped. */
  taskTimeoutMinutes: number;
  /**
   * Element threads (docs/PLAN-threads.md): route each turn to a per-element thread with its own persistent harness
   * session instead of one conversation. Needs `memory`.
   */
  threads: boolean;
  /**
   * Text only: nothing is spoken back (no TTS, no progress lines), for this turn and for the runs it starts on a
   * thread (their results and reminders show as bubbles). Typed comments (shared/comment.ts) set it.
   */
  silent?: boolean;
  /** Speech language for Scribe and the pointing word lists (benchmarks stay pinned to "en"). */
  language: SpeechLanguage;
  /** Harness or API + model for each tier: fast = router and progress lines, smart = hard questions and tasks. */
  llm: Record<LlmTier, LlmChoice>;
  /** Voice for the chosen TTS model, when it has several (Piper / Kokoro / OpenAI voice name); default = the engine's. */
  ttsVoice?: string;
  /** Delivery for Fish Audio Drama 3 (direction, speed, volume); ignored by the other engines. */
  ttsStyle: TtsStyle;
}

export const DEFAULT_CONFIG: RunConfig = {
  approach: "pipeline",
  solverFast: false,
  routerMode: "forced",
  ttsModel: "macos",
  sttModel: "local_apple",
  prewarm: true,
  preMs: 300,
  postMs: 200,
  memory: false,
  fillers: false,
  backgroundLongTasks: false,
  longTaskSeconds: 20,
  taskTimeoutMinutes: 15,
  threads: false,
  language: "en",
  llm: { fast: { provider: "claude-code", model: "claude-haiku-5-5", level: "low" }, smart: { provider: "claude-code", model: "claude-opus-5-5", level: "medium" } },
  ttsStyle: DEFAULT_TTS_STYLE,
};

/**
 * The config's tier choices. Configs from before tiers carry `claudeBackend` instead: they get the default (Claude
 * Code). A model API is only allowed on the fast tier (the solver needs a harness's file tools).
 */
export function llmOf(config: Partial<RunConfig>): Record<LlmTier, LlmChoice> {
  const llm = config.llm;
  if (!llm) return DEFAULT_CONFIG.llm;
  return {
    fast: llm.fast && isLlmProvider(llm.fast.provider) ? llm.fast : DEFAULT_CONFIG.llm.fast,
    smart: llm.smart && isHarness(llm.smart.provider) ? llm.smart : DEFAULT_CONFIG.llm.smart,
  };
}

/** The solver time limit (Settings → Models → Turns): whole minutes in this range. */
export const TASK_TIMEOUT_MIN = 1;
export const TASK_TIMEOUT_MAX = 240;
export const validTaskTimeout = (m: unknown): m is number => Number.isInteger(m) && (m as number) >= TASK_TIMEOUT_MIN && (m as number) <= TASK_TIMEOUT_MAX;
/** The config's solver time limit in ms (a config without a valid one gets the default). */
export function taskTimeoutMs(config: Partial<RunConfig>): number {
  return (validTaskTimeout(config.taskTimeoutMinutes) ? config.taskTimeoutMinutes : DEFAULT_CONFIG.taskTimeoutMinutes) * 60_000;
}

export const MODELS = {
  scribe: "scribe_v2_realtime",
} as const;

/** Audio format used on every hop: PCM16 mono little-endian. */
export const SAMPLE_RATE = 24000;
