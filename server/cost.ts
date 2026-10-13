// Cost per turn from usage × prices in docs/API-NOTES.md §Prices (USD).
//
// Usage shapes (TurnResult.usage, built by the orchestrators):
//   anthropic: { haiku?: Anthropic usage, opus?: Anthropic usage }  — {input_tokens, output_tokens,
//              cache_read_input_tokens, cache_creation_input_tokens, speed?}; input_tokens excludes cache reads/writes.
//   openai:    RealtimeUsage for this turn only — { responses: raw[], totals: {inputText, inputAudio, cachedText, cachedAudio, outputText, outputAudio, ...} }
//   elevenChars: TTS characters sent;  scribeSeconds: audio seconds sent to Scribe.
//
// Assumptions where API-NOTES lists no price (documented here, change in one place):
//   - Claude cache writes (5-min ephemeral) bill at 1.25× the input rate.
//   - Haiku cache reads bill at 0.1× its input rate. Opus fast-mode cache reads at 2× the standard $0.20.
//   - Realtime: the single "cached" price applies to cached text and cached audio tokens alike.
//   - Haiku's >100K-token prompt tier is chosen from input + cache read + cache write tokens.
import type { RunConfig } from "../shared/config.ts";
import type { Usage } from "../shared/protocol.ts";

const PER_M = 1e-6;

export const PRICES = {
  haiku: { in: 0.1, out: 0.5, longIn: 0.5, longOut: 2.5, longThreshold: 100_000 },
  opus: { in: 4, out: 20, cacheRead: 0.2 },
  opusFast: { in: 8, out: 40, cacheRead: 0.4 },
  cacheWriteMultiplier: 1.25,
  haikuCacheReadMultiplier: 0.1,
  realtime: {
    "gpt-realtime-2.1": { audioIn: 32, cached: 0.4, audioOut: 64, textIn: 4, textOut: 24 },
    "gpt-realtime-2.1-mini": { audioIn: 10, cached: 0.3, audioOut: 20, textIn: 0.6, textOut: 2.4 },
  },
  elevenPerChar: 0.04 / 1000,
  scribePerSecond: 0.39 / 3600,
} as const;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export interface CostBreakdown { haiku: number; opus: number; openai: number; tts: number; stt: number; total: number }

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

export function realtimeCost(u: unknown, model: RunConfig["realtimeModel"]): number {
  const t = obj(obj(u).totals);
  const p = PRICES.realtime[model] ?? PRICES.realtime["gpt-realtime-2.1"];
  const cachedText = num(t.cachedText), cachedAudio = num(t.cachedAudio);
  return (
    Math.max(0, num(t.inputText) - cachedText) * p.textIn +
    Math.max(0, num(t.inputAudio) - cachedAudio) * p.audioIn +
    (cachedText + cachedAudio) * p.cached +
    num(t.outputText) * p.textOut +
    num(t.outputAudio) * p.audioOut
  ) * PER_M;
}

export function costBreakdown(config: RunConfig, usage: Usage): CostBreakdown {
  const a = obj(usage.anthropic);
  const b = {
    haiku: a.haiku ? haikuCost(a.haiku) : 0,
    opus: a.opus ? opusCost(a.opus, config.opusFast) : 0,
    openai: usage.openai ? realtimeCost(usage.openai, config.realtimeModel) : 0,
    tts: num(usage.elevenChars) * PRICES.elevenPerChar,
    stt: num(usage.scribeSeconds) * PRICES.scribePerSecond,
  };
  return { ...b, total: b.haiku + b.opus + b.openai + b.tts + b.stt };
}

export function computeCost(config: RunConfig, usage: Usage): number {
  return costBreakdown(config, usage).total;
}
