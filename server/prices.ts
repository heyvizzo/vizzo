// Per-token prices for models outside the Claude price table in cost.ts (Codex, Grok, and Pi / OhMyPi when
// they report none): the models.dev catalog (the one opencode uses), fetched once in the background at server start. Until it arrives, or for a model it
// doesn't list, a call's price is unknown (cost 0, marked "price unknown"). The model APIs' model lists (and their
// reasoning levels) come from the same catalog (`catalogModels`).
import type { LlmModelInfo, LlmProvider } from "../shared/config.ts";

const CATALOG_URL = "https://models.dev/api.json";

/** USD per 1M tokens. */
export interface TokenPrice { input: number; output: number; cacheRead?: number; cacheWrite?: number }

/** Which models.dev provider prices each of our providers' models. */
const CATALOG_PROVIDER: Record<LlmProvider, string> = {
  "claude-code": "anthropic", codex: "openai", grok: "xai", opencode: "", pi: "", omp: "",
  openrouter: "openrouter", fireworks: "fireworks-ai", cerebras: "cerebras", anthropic: "anthropic", openai: "openai", zai: "zai",
};

/** A catalog model's reasoning options: effort levels, and/or a toggle (reasoning can be turned off). */
type ReasoningOption = { type?: string; values?: string[] };

let catalog: Map<string, TokenPrice> | null = null;
/** Per catalog provider: its models and their levels (for the model APIs' lists). */
let catalogLists: Map<string, LlmModelInfo[]> | null = null;
let loading: Promise<void> | null = null;

/** Fetch the catalog (once; failures are logged and leave prices unknown). */
export function loadPriceCatalog(log: (msg: string) => void = console.info): Promise<void> {
  return (loading ??= (async () => {
    try {
      const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, { models?: Record<string, {
        cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
        reasoning?: boolean; reasoning_options?: ReasoningOption[] | null; modalities?: { output?: string[] };
      }> }>;
      const wanted = new Set([...Object.values(CATALOG_PROVIDER), ...Object.values(OPENCODE_PROVIDER)].filter(Boolean));
      const map = new Map<string, TokenPrice>();
      const lists = new Map<string, LlmModelInfo[]>();
      for (const p of wanted) {
        const list: LlmModelInfo[] = [];
        for (const [id, m] of Object.entries(data[p]?.models ?? {})) {
          if (!m.modalities?.output || m.modalities.output.includes("text")) list.push(catalogModelInfo(id, m.reasoning ? m.reasoning_options ?? [] : []));
          const c = m.cost;
          if (typeof c?.input !== "number" || typeof c.output !== "number") continue;
          map.set(`${p}/${id}`, { input: c.input, output: c.output, cacheRead: c.cache_read, cacheWrite: c.cache_write });
        }
        lists.set(p, list.sort((a, b) => a.id.localeCompare(b.id)));
      }
      catalog = map;
      catalogLists = lists;
      log(`[prices] models.dev catalog: ${map.size} model prices`);
    } catch (e) {
      log(`[prices] models.dev catalog unavailable (${e instanceof Error ? e.message : String(e)}); non-Claude prices unknown`);
    }
  })());
}

/**
 * A model's levels from its catalog reasoning options: its effort values, with "off" in front when reasoning can be
 * turned off (a toggle). Toggle only: "off" / "on". A model that can turn reasoning off starts the fast tier with it off.
 */
export function catalogModelInfo(id: string, options: ReasoningOption[]): LlmModelInfo {
  const efforts = options.find((o) => o.type === "effort")?.values ?? [];
  const toggle = options.some((o) => o.type === "toggle");
  const levels = toggle && !efforts.includes("none") ? ["off", ...(efforts.length ? efforts : ["on"])] : [...efforts];
  const off = levels.includes("off") ? "off" : levels.includes("none") ? "none" : undefined;
  return { id, levels, ...(off ? { fastLevel: off } : {}), fast: false };
}

/** The catalog's models for a model API (null until the catalog has loaded, or if it couldn't be fetched). */
export function catalogModels(provider: LlmProvider): LlmModelInfo[] | null {
  const p = CATALOG_PROVIDER[provider];
  return (p && catalogLists?.get(p)) || null;
}

/** opencode / Pi / OhMyPi model ids are "provider/model": the provider part names the catalog entry. */
const OPENCODE_PROVIDER: Record<string, string> = {
  opencode: "opencode", openrouter: "openrouter", cerebras: "cerebras", "fireworks-ai": "fireworks-ai", "openai-codex": "openai",
  anthropic: "anthropic", openai: "openai", xai: "xai", google: "google", groq: "groq", deepseek: "deepseek",
};

/** The catalog price of `model` on `provider`, or null (catalog not loaded, or model not listed). */
export function priceOf(provider: LlmProvider, model: string): TokenPrice | null {
  if (!catalog || !model) return null;
  let p = CATALOG_PROVIDER[provider];
  let id = model;
  if (!p) {
    const i = model.indexOf("/");
    p = OPENCODE_PROVIDER[model.slice(0, i)] ?? "";
    id = model.slice(i + 1);
  }
  if (!p) return null;
  // Claude ids: the catalog lists "claude-opus-5-5"; OpenRouter-style "anthropic/claude-opus-5.5" maps to it.
  if (p === "anthropic") id = id.replace(/^anthropic\//, "").replace(/(\d+)\.(\d+)/g, "$1-$2");
  return catalog.get(`${p}/${id}`) ?? null;
}

/** USD for token counts at `price` (input excludes cached tokens). */
export function tokenCost(price: TokenPrice, t: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): number {
  return (
    t.input * price.input + t.output * price.output +
    (t.cacheRead ?? 0) * (price.cacheRead ?? price.input) + (t.cacheWrite ?? 0) * (price.cacheWrite ?? price.input)
  ) / 1e6;
}

/** Tests: set the catalog directly (null = not loaded). */
export function setPriceCatalog(entries: Record<string, TokenPrice> | null, lists?: Record<string, LlmModelInfo[]>): void {
  catalog = entries ? new Map(Object.entries(entries)) : null;
  catalogLists = lists ? new Map(Object.entries(lists)) : null;
}
