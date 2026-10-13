// Cost per turn from usage × prices in docs/API-NOTES.md §Prices (USD).
//
// Usage shapes (TurnResult.usage, built by the orchestrators):
//   anthropic: { haiku?: Anthropic usage, opus?: Anthropic usage, fillers?: Anthropic usage (progress lines) }  — {input_tokens, output_tokens,
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
import type { CostItem, Usage } from "../shared/protocol.ts";

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
  /** OpenAI tts-1: $15 per 1M characters. */
  openaiTtsPerChar: 15 / 1_000_000,
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

/** Claude calls routed through `claude -p` run on the subscription: not billed per call. */
export const claudeBilled = (config: RunConfig): boolean => config.claudeBackend !== "cli";

export function costBreakdown(config: RunConfig, usage: Usage): CostBreakdown {
  const a = obj(usage.anthropic);
  const billed = claudeBilled(config) ? 1 : 0;
  const b = {
    // Router + the progress-lines call (both Haiku).
    haiku: billed * ((a.haiku ? haikuCost(a.haiku) : 0) + (a.fillers ? haikuCost(a.fillers) : 0)),
    opus: billed * (a.opus ? opusCost(a.opus, config.opusFast) : 0),
    openai: usage.openai ? realtimeCost(usage.openai, config.realtimeModel) : 0,
    tts: num(usage.elevenChars) * PRICES.elevenPerChar + num(usage.openaiTtsChars) * PRICES.openaiTtsPerChar,
    stt: num(usage.scribeSeconds) * PRICES.scribePerSecond,
  };
  return { ...b, total: b.haiku + b.opus + b.openai + b.tts + b.stt };
}

export function computeCost(config: RunConfig, usage: Usage): number {
  return costBreakdown(config, usage).total;
}

// ── Per call and itemized (debug view: cost of each prompt + response, and of a whole turn) ──────

/** One Realtime `response.done` usage object (OpenAI's raw shape). */
export function realtimeResponseCost(raw: unknown, model: RunConfig["realtimeModel"]): number {
  const u = obj(raw);
  const inD = obj(u.input_token_details), outD = obj(u.output_token_details), cachedD = obj(inD.cached_tokens_details);
  const cached = num(inD.cached_tokens);
  const cachedText = num(cachedD.text_tokens) || (cached && !num(cachedD.audio_tokens) ? cached : 0);
  const cachedAudio = num(cachedD.audio_tokens);
  const totals = {
    inputText: num(inD.text_tokens), inputAudio: num(inD.audio_tokens), cachedText, cachedAudio,
    outputText: num(outD.text_tokens), outputAudio: num(outD.audio_tokens),
  };
  return realtimeCost({ totals }, model);
}

/** Cost of one model call from its usage. */
export function callCost(target: "router" | "fillers" | "opus" | "realtime", usage: unknown, realtimeModel: RunConfig["realtimeModel"]): number {
  if (!usage) return 0;
  if (target === "opus") return opusCost(usage, false);
  if (target === "realtime") return realtimeResponseCost(usage, realtimeModel);
  return haikuCost(usage);
}

const fmtSecs = (s: number) => `${s.toFixed(1)} s`;

/** A turn's cost, itemized (sums to computeCost). Zero items are left out. */
export function costItems(config: RunConfig, usage: Usage): CostItem[] {
  const a = obj(usage.anthropic);
  const items: CostItem[] = [];
  const tokens = (u: unknown) => {
    const x = obj(u);
    const read = num(x.cache_read_input_tokens), write = num(x.cache_creation_input_tokens);
    return `in ${num(x.input_tokens)}${read ? ` + ${read} cached` : ""}${write ? ` + ${write} cache write` : ""} · out ${num(x.output_tokens)}`;
  };
  // claude -p: billed to the subscription, so 0 here, with the API-price cost as "saved".
  const claude = (label: string, usd: number, u: unknown): CostItem => claudeBilled(config)
    ? { label, usd, detail: tokens(u) }
    : { label: `${label} (claude -p · subscription)`, usd: 0, savedUsd: usd, savedVia: "subscription", detail: tokens(u) };
  if (a.haiku) items.push(claude("Haiku router", haikuCost(a.haiku), a.haiku));
  if (a.fillers) items.push(claude("Haiku progress lines", haikuCost(a.fillers), a.fillers));
  if (a.opus) items.push(claude("Opus", opusCost(a.opus, config.opusFast), a.opus));
  if (usage.openai) {
    const u = obj(usage.openai);
    const n = Array.isArray(u.responses) ? u.responses.length : 0;
    const t = obj(u.totals);
    items.push({
      label: `OpenAI Realtime (${config.realtimeModel})`, usd: realtimeCost(usage.openai, config.realtimeModel),
      detail: `${n} response${n === 1 ? "" : "s"} · audio in ${num(t.inputAudio)} · out ${num(t.outputAudio)} tokens`,
    });
  }
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
  const local = num(usage.localTtsChars);
  if (local) {
    const segs = (usage.elevenSegments ?? []).filter((s) => s.chars > 0);
    items.push({
      label: "macOS TTS (on-device)", usd: 0, savedUsd: local * PRICES.elevenPerChar, savedVia: "on-device",
      detail: `${segs.length ? segs.map((s) => `${s.label} ${s.chars}`).join(" · ") : local} chars · saved vs ElevenLabs`,
    });
  }
  const secs = num(usage.scribeSeconds);
  if (secs) items.push({ label: "Scribe STT", usd: secs * PRICES.scribePerSecond, detail: fmtSecs(secs) });
  return items.filter((i) => i.usd > 0 || (i.savedUsd ?? 0) > 0);
}
