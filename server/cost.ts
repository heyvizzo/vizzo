// Cost per turn from usage × prices in docs/API-NOTES.md §Prices (USD).
//
// Usage shapes (TurnResult.usage, built by the orchestrators):
//   anthropic: { router?: router usage, solver?: solver usage, fillers?: progress-lines usage } (fast tier: router,
//              fillers; smart tier: solver) — {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, speed?};
//              input_tokens excludes cache reads/writes. Calls outside Claude carry their own price in `llmCost`
//              (adapters/harnesses.ts LlmUsage); Claude calls are priced here by model.
//   elevenChars: TTS characters sent;  scribeSeconds: audio seconds sent to Scribe;  openRouterSttSeconds + openRouterSttModel: to an OpenRouter STT model;
//   localSttSeconds: transcribed on-device (free).
//
// Assumptions where API-NOTES lists no price (documented here, change in one place):
//   - Claude cache writes (5-min ephemeral) bill at 1.25× the input rate.
//   - Haiku cache reads bill at 0.1× its input rate. Opus fast-mode cache reads at 2× the standard $0.20.
//   - Haiku's >100K-token prompt tier is chosen from input + cache read + cache write tokens.
import { LLM_PROVIDER_LABELS, STT_LABELS, isLocalStt, STT_OPENROUTER_MODEL, TTS_LABELS, llmOf, type LlmTier, type RunConfig, type SttModel } from "../shared/config.ts";
import { priceOf, tokenCost } from "./prices.ts";
import type { CostItem, PromptTarget, Usage } from "../shared/protocol.ts";

const PER_M = 1e-6;

export const PRICES = {
  haiku: { in: 0.1, out: 0.5, longIn: 0.5, longOut: 2.5, longThreshold: 100_000 },
  opus: { in: 4, out: 20, cacheRead: 0.2 },
  opusFast: { in: 8, out: 40, cacheRead: 0.4 },
  cacheWriteMultiplier: 1.25,
  haikuCacheReadMultiplier: 0.1,
  elevenPerChar: 0.04 / 1000,
  /** OpenAI tts-1: $15 per 1M characters. */
  openaiTtsPerChar: 15 / 1_000_000,
  /** Fish Audio Drama 3 via OpenRouter: $2 per 1M characters (usage.cost on measured generations). */
  fishTtsPerChar: 2 / 1_000_000,
  scribePerSecond: 0.39 / 3600,
  /** OpenRouter STT, per audio second, by model id. Whisper and Nemotron measured (usage.cost); Fish from the catalog. */
  openRouterSttPerSecond: {
    "openai/whisper-large-v3": 0.000025,
    "fish-audio/transcribe-1": 0.0001,
    "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b": 0.00000333,
  } as Record<string, number>,
} as const;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Usage for the speech-to-text engine that ran this turn (Scribe, an OpenRouter STT model, or on-device). */
export function sttUsage(model: SttModel, seconds: number): Pick<Usage, "scribeSeconds" | "openRouterSttSeconds" | "openRouterSttModel" | "localSttSeconds"> {
  if (model === "scribe_v2") return { scribeSeconds: seconds };
  if (isLocalStt(model)) return { localSttSeconds: seconds };
  return { openRouterSttSeconds: seconds, openRouterSttModel: STT_OPENROUTER_MODEL[model] };
}
/** USD for a turn's OpenRouter STT usage. */
export function openRouterSttCost(usage: Pick<Usage, "openRouterSttSeconds" | "openRouterSttModel">): number {
  return num(usage.openRouterSttSeconds) * (PRICES.openRouterSttPerSecond[usage.openRouterSttModel ?? ""] ?? 0);
}

export interface CostBreakdown { fast: number; smart: number; tts: number; stt: number; total: number }

export function haikuCost(u: unknown): number {
  const x = obj(u);
  const input = num(x.input_tokens), out = num(x.output_tokens);
  const read = num(x.cache_read_input_tokens), write = num(x.cache_creation_input_tokens);
  const long = input + read + write > PRICES.haiku.longThreshold;
  const pin = long ? PRICES.haiku.longIn : PRICES.haiku.in;
  const pout = long ? PRICES.haiku.longOut : PRICES.haiku.out;
  return (input * pin + write * pin * PRICES.cacheWriteMultiplier + read * pin * PRICES.haikuCacheReadMultiplier + out * pout) * PER_M;
}

export function opusCost(u: unknown, fastFallback: boolean): number {
  const x = obj(u);
  const fast = x.speed === "fast" || (x.speed == null && fastFallback);
  const p = fast ? PRICES.opusFast : PRICES.opus;
  const input = num(x.input_tokens), out = num(x.output_tokens);
  const read = num(x.cache_read_input_tokens), write = num(x.cache_creation_input_tokens);
  return (input * p.in + write * p.in * PRICES.cacheWriteMultiplier + read * p.cacheRead + out * p.out) * PER_M;
}

/**
 * A Claude call's cost by model: Haiku 5.5 and Opus 5.5 from the table above, any other Claude model from the
 * models.dev catalog (null if it isn't there). No model: the price of `tier`'s default model (Haiku 5.5 for fast, Opus 5.5 for smart).
 */
export function claudeCost(u: unknown, model: string | undefined, tier: LlmTier, fastFallback = false): number | null {
  const m = model ?? "";
  if (m ? /haiku-5[-.]5/.test(m) : tier === "fast") return haikuCost(u);
  if (m ? /opus-5[-.]5/.test(m) : tier === "smart") return opusCost(u, fastFallback);
  const price = priceOf("claude-code", m);
  if (!price) return null;
  const x = obj(u);
  return tokenCost(price, { input: num(x.input_tokens), output: num(x.output_tokens), cacheRead: num(x.cache_read_input_tokens), cacheWrite: num(x.cache_creation_input_tokens) });
}

export interface CallCost { usd: number; billing: "api" | "subscription"; /** false: no price for this model (usd is 0). */ known: boolean }

/**
 * What one call of `tier` cost and who pays. Non-Claude calls carry their own (`llmCost`); Claude calls are
 * priced by the tier's model and billed unless they ran through Claude Code (the subscription).
 */
export function llmCallCost(config: RunConfig, tier: LlmTier, u: unknown, fastFallback = false): CallCost {
  const own = obj(u).llmCost;
  if (own) {
    const c = obj(own);
    return { usd: num(c.usd), billing: c.billing === "subscription" ? "subscription" : "api", known: typeof c.usd === "number" };
  }
  const choice = llmOf(config)[tier];
  const usd = claudeCost(u, choice.model, tier, fastFallback);
  return { usd: usd ?? 0, billing: choice.provider === "claude-code" ? "subscription" : "api", known: usd !== null };
}

/** Billed USD of a tier's call (0 when a subscription pays). */
const billedCost = (config: RunConfig, tier: LlmTier, u: unknown, fastFallback = false): number => {
  if (!u) return 0;
  const c = llmCallCost(config, tier, u, fastFallback);
  return c.billing === "api" ? c.usd : 0;
};

export function costBreakdown(config: RunConfig, usage: Usage): CostBreakdown {
  const a = obj(usage.anthropic);
  const b = {
    // Fast tier: the router + the progress-lines call. Smart tier: the solver.
    fast: billedCost(config, "fast", a.router) + billedCost(config, "fast", a.fillers),
    smart: billedCost(config, "smart", a.solver, config.solverFast),
    tts: num(usage.elevenChars) * PRICES.elevenPerChar + num(usage.openaiTtsChars) * PRICES.openaiTtsPerChar + num(usage.fishTtsChars) * PRICES.fishTtsPerChar,
    stt: num(usage.scribeSeconds) * PRICES.scribePerSecond + openRouterSttCost(usage),
  };
  return { ...b, total: b.fast + b.smart + b.tts + b.stt };
}

export function computeCost(config: RunConfig, usage: Usage): number {
  return costBreakdown(config, usage).total;
}

// ── Per call and itemized (debug view: cost of each prompt + response, and of a whole turn) ──────

/** Cost of one model call from its usage (its own `llmCost` if it has one; Claude prices by `model` otherwise). */
export function callCost(target: PromptTarget, usage: unknown, model?: string): number {
  if (!usage) return 0;
  const own = obj(usage).llmCost;
  if (own) return num(obj(own).usd);
  return claudeCost(usage, model, target === "solver" ? "smart" : "fast") ?? 0;
}

const tokensDetail = (u: unknown): string => {
  const x = obj(u);
  const read = num(x.cache_read_input_tokens), write = num(x.cache_creation_input_tokens);
  return `in ${num(x.input_tokens)}${read ? ` + ${read} cached` : ""}${write ? ` + ${write} cache write` : ""} · out ${num(x.output_tokens)}`;
};

/**
 * One tier call as a cost line: "Router · gpt-6-luna". A subscription call is 0 billed, with its API-price cost
 * as saved. No price for the model: 0, marked in the detail.
 */
export function llmCostItem(config: RunConfig, tier: LlmTier, u: unknown, role: string, fastFallback = false): CostItem {
  const choice = llmOf(config)[tier];
  const c = llmCallCost(config, tier, u, fastFallback);
  const label = `${role} · ${choice.model || `${LLM_PROVIDER_LABELS[choice.provider]} default`}`;
  const detail = tokensDetail(u) + (c.known ? "" : " · price unknown");
  return c.billing === "subscription"
    ? { label: `${label} (${LLM_PROVIDER_LABELS[choice.provider]} · subscription)`, usd: 0, savedUsd: c.usd, savedVia: "subscription", detail }
    : { label: `${label} (${LLM_PROVIDER_LABELS[choice.provider]})`, usd: c.usd, detail };
}

const fmtSecs = (s: number) => `${s.toFixed(1)} s`;

/** A turn's cost, itemized (sums to computeCost). Zero items are left out. */
export function costItems(config: RunConfig, usage: Usage): CostItem[] {
  const a = obj(usage.anthropic);
  // Model calls are listed even at $0 (a free model, or one without a known price).
  const calls: CostItem[] = [];
  if (a.router) calls.push(llmCostItem(config, "fast", a.router, "Router"));
  if (a.fillers) calls.push(llmCostItem(config, "fast", a.fillers, "Progress lines"));
  if (a.solver) calls.push(llmCostItem(config, "smart", a.solver, "Solver", config.solverFast));
  const items: CostItem[] = [];
  const chars = num(usage.elevenChars);
  if (chars) {
    const segs = (usage.elevenSegments ?? []).filter((s) => s.chars > 0);
    items.push({
      label: `ElevenLabs TTS (${config.ttsModel})`, usd: chars * PRICES.elevenPerChar,
      detail: segs.length ? `${segs.map((s) => `${s.label} ${s.chars}`).join(" · ")} chars` : `${chars} chars`,
    });
  }
  const oaChars = num(usage.openaiTtsChars);
  if (oaChars) {
    const segs = (usage.elevenSegments ?? []).filter((s) => s.chars > 0);
    items.push({ label: "OpenAI TTS (tts-1)", usd: oaChars * PRICES.openaiTtsPerChar, detail: segs.length ? `${segs.map((s) => `${s.label} ${s.chars}`).join(" · ")} chars` : `${oaChars} chars` });
  }
  const fishChars = num(usage.fishTtsChars);
  if (fishChars) {
    const segs = (usage.elevenSegments ?? []).filter((s) => s.chars > 0);
    items.push({ label: "Fish Audio TTS (drama-3)", usd: fishChars * PRICES.fishTtsPerChar, detail: segs.length ? `${segs.map((s) => `${s.label} ${s.chars}`).join(" · ")} chars` : `${fishChars} chars` });
  }
  const local = num(usage.localTtsChars);
  if (local) {
    const segs = (usage.elevenSegments ?? []).filter((s) => s.chars > 0);
    items.push({
      label: `${TTS_LABELS[config.ttsModel]} (on-device)`, usd: 0, savedUsd: local * PRICES.elevenPerChar, savedVia: "on-device",
      detail: `${segs.length ? segs.map((s) => `${s.label} ${s.chars}`).join(" · ") : local} chars · saved vs ElevenLabs`,
    });
  }
  const secs = num(usage.scribeSeconds);
  if (secs) items.push({ label: "Scribe STT", usd: secs * PRICES.scribePerSecond, detail: fmtSecs(secs) });
  const orStt = num(usage.openRouterSttSeconds);
  if (orStt) items.push({ label: STT_LABELS[config.sttModel], usd: openRouterSttCost(usage), detail: fmtSecs(orStt) });
  const localStt = num(usage.localSttSeconds);
  if (localStt) {
    items.push({ label: STT_LABELS[config.sttModel], usd: 0, savedUsd: localStt * PRICES.scribePerSecond, savedVia: "on-device", detail: `${fmtSecs(localStt)} · saved vs Scribe` });
  }
  return [...calls, ...items.filter((i) => i.usd > 0 || (i.savedUsd ?? 0) > 0)];
}
