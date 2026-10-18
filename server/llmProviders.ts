// What the Chat page offers per tier: which harnesses are installed (GET /api/llm/providers), and each
// harness's models with the reasoning levels and speeds it offers for them (GET /api/llm/models?provider=…,
// cached; POST /api/llm/scan lists them all afresh), read from the harness itself:
//   claude-code  --effort low…max on every model; fast mode on Opus 5.5 (needs usage credits on the account)
//   codex        its model cache: supported reasoning levels, and a "priority" service tier = Fast
//   grok         its ACP agent's model list (reasoning efforts per model); no fast tier
//   opencode     `opencode models --verbose`: each model's variants are its levels
//   pi           `pi --list-models`: thinking levels when the model reasons
//   omp          `omp models --json`: thinking levels per model; Fast = OpenAI's priority tier or Opus fast mode
// The model APIs (fast tier only) are listed after the harnesses: usable when their key is set in Settings, their
// models and levels from the models.dev catalog (prices.ts).
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  API_KEY_ENV, API_PROVIDERS, HARNESSES, LLM_PROVIDER_LABELS, isApiProvider, isLlmProvider, type ApiProviderId, type HarnessId, type HarnessScan,
  type LlmModelInfo, type LlmProvider,
} from "../shared/config.ts";
import { harnessBin } from "./adapters/harnesses.ts";
import { EMPTY_CWD } from "./adapters/claudeCli.ts";
import { catalogModels, loadPriceCatalog } from "./prices.ts";

export type ProviderInfo = Omit<HarnessScan, "models" | "error">;

const INSTALL: Partial<Record<HarnessId, string>> = {
  pi: "npm i -g @mariozechner/pi-coding-agent", omp: "bun add -g @oh-my-pi/pi-coding-agent",
};

/** The Settings label of each model API's key. */
const KEY_LABEL: Record<ApiProviderId, string> = {
  openrouter: "OpenRouter", fireworks: "Fireworks", cerebras: "Cerebras", anthropic: "Anthropic", openai: "OpenAI", zai: "Z.ai",
};

export function providerStatus(): ProviderInfo[] {
  const harnesses = HARNESSES.map((id): ProviderInfo => {
    const ok = !!harnessBin(id);
    return { id, label: LLM_PROVIDER_LABELS[id], available: ok, ...(ok ? {} : { note: `not installed${INSTALL[id] ? ` (${INSTALL[id]})` : ""}` }) };
  });
  const apis = API_PROVIDERS.map((id): ProviderInfo => {
    const ok = !!process.env[API_KEY_ENV[id]]?.trim();
    return { id, label: LLM_PROVIDER_LABELS[id], available: ok, api: true, ...(ok ? {} : { note: `no key (add the ${KEY_LABEL[id]} API key in Settings → API keys)` }) };
  });
  return [...harnesses, ...apis];
}

/**
 * A model API's models: the catalog's, waiting for it to load. Z.ai can turn thinking off on every GLM model
 * (`thinking: disabled`), so its models get "off" even where the catalog lists only efforts.
 */
export async function apiModels(id: ApiProviderId): Promise<LlmModelInfo[]> {
  await loadPriceCatalog();
  const models = catalogModels(id) ?? [];
  if (id !== "zai") return models;
  return models.map((m) => (m.levels.length && !m.levels.includes("off") ? { ...m, levels: ["off", ...m.levels], fastLevel: "off" } : m));
}

/** A listing command's output: stdout, or stderr when that's where it printed (pi --list-models). */
const run = (bin: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => execFile(bin, args, { timeout: 30_000, maxBuffer: 32 << 20, env: process.env }, (e, out, err) => (e ? reject(e) : resolve(out.trim() ? out : err))));

const CLAUDE_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"];
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Grok's models and their reasoning efforts, from its ACP agent (`grok agent stdio`) as it starts a session. */
function grokModels(bin: string): Promise<LlmModelInfo[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ["agent", "stdio"], { cwd: EMPTY_CWD, stdio: ["pipe", "pipe", "ignore"], env: process.env });
    const timer = setTimeout(() => { p.kill(); reject(new Error("grok: no model list within 20 s")); }, 20_000);
    let buf = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: { method?: string; params?: { availableModels?: { modelId: string; _meta?: { reasoningEffort?: string; reasoningEfforts?: { id: string }[] } }[] } };
        try { m = JSON.parse(line); } catch { continue; }
        if (m.method !== "_x.ai/models/update") continue;
        clearTimeout(timer);
        p.kill();
        resolve((m.params?.availableModels ?? []).map((x) => {
          const levels = (x._meta?.reasoningEfforts ?? []).map((e) => e.id).reverse(); // listed strongest first
          return { id: x.modelId, levels, ...(x._meta?.reasoningEffort ? { defaultLevel: x._meta.reasoningEffort } : {}), fast: false };
        }));
      }
    });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    const send = (o: object) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
    send({ id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    send({ id: 2, method: "session/new", params: { cwd: EMPTY_CWD, mcpServers: [] } });
  });
}

/** `opencode models --verbose`: "provider/model" lines, each followed by the model's JSON. */
export function parseOpencodeVerbose(out: string): LlmModelInfo[] {
  const models: LlmModelInfo[] = [];
  const re = /^([\w.-]+\/\S+)\n(\{[\s\S]*?\n\})$/gm;
  for (const m of out.matchAll(re)) {
    let info: { variants?: Record<string, unknown> } = {};
    try { info = JSON.parse(m[2]!); } catch { /* keep the id */ }
    const levels = Object.keys(info.variants ?? {});
    models.push({ id: m[1]!, levels: levels.filter((l) => l !== "fast"), fast: levels.includes("fast") });
  }
  return models;
}

/** omp can send a faster tier for OpenAI models (priority) and Opus (Anthropic fast mode); not via OpenRouter. */
const ompFast = (provider: string, id: string): boolean =>
  provider === "openai" || provider === "openai-codex" || (provider === "anthropic" && /opus/.test(id));

async function listModels(id: HarnessId, bin: string): Promise<LlmModelInfo[]> {
  switch (id) {
    case "claude-code":
      return CLAUDE_MODELS.map((m) => ({ id: m, levels: CLAUDE_LEVELS, defaultLevel: "medium", fast: /opus-5-5/.test(m) }));
    case "codex": {
      // Codex caches the model list it fetched for this login.
      const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
      const cache = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8")) as {
        models?: { slug?: string; visibility?: string; default_reasoning_level?: string; supported_reasoning_levels?: { effort: string }[]; service_tiers?: { id: string }[] }[];
      };
      return (cache.models ?? []).filter((m) => m.slug && m.visibility !== "hide").map((m) => ({
        id: m.slug!, levels: (m.supported_reasoning_levels ?? []).map((l) => l.effort),
        ...(m.default_reasoning_level ? { defaultLevel: m.default_reasoning_level } : {}),
        fast: (m.service_tiers ?? []).some((t) => t.id === "priority"),
      }));
    }
    case "grok":
      try { return await grokModels(bin); } catch {
        return [...(await run(bin, ["models"])).matchAll(/^\s*[*-]\s+(\S+)/gm)].map((m) => ({ id: m[1]!, levels: ["low", "medium", "high"], fast: false }));
      }
    case "opencode":
      return parseOpencodeVerbose(await run(bin, ["models", "--verbose"]));
    case "pi":
      // A table: provider, model, context, max-out, thinking (yes/no), images.
      return (await run(bin, ["--list-models"])).split("\n").map((l) => l.trim().split(/\s+/))
        .filter((c) => c.length >= 5 && c[0] !== "provider" && /^[\w.-]+$/.test(c[0]!))
        .map((c) => ({ id: `${c[0]}/${c[1]}`, levels: c[4] === "yes" ? PI_LEVELS : [], fast: false }));
    case "omp": {
      type OmpModel = { provider: string; id: string; selector?: string; thinking?: string[] };
      const out = JSON.parse(await run(bin, ["models", "--json"])) as OmpModel[] | { models: OmpModel[] };
      return (Array.isArray(out) ? out : out.models).map((m) => ({ id: m.selector ?? `${m.provider}/${m.id}`, levels: m.thinking ?? [], fast: ompFast(m.provider, m.id) }));
    }
  }
}

const cache = new Map<LlmProvider, { at: number; models: LlmModelInfo[] }>();
const TTL_MS = 10 * 60_000;

/** The harness's or API's models, listed now (and cached); throws if it isn't installed or they can't be listed. */
async function freshModels(id: LlmProvider): Promise<LlmModelInfo[]> {
  if (isApiProvider(id)) {
    const models = await apiModels(id);
    if (models.length) cache.set(id, { at: Date.now(), models });
    return models;
  }
  const bin = harnessBin(id);
  if (!bin) throw new Error("not installed");
  const models = await listModels(id, bin);
  cache.set(id, { at: Date.now(), models });
  return models;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The harness's or API's models (cached for 10 min); [] if they can't be listed (the field still takes any id). */
export async function providerModels(id: LlmProvider): Promise<LlmModelInfo[]> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.models;
  if (!isApiProvider(id) && !harnessBin(id)) return [];
  try { return await freshModels(id); } catch (e) {
    console.info(`[llm] couldn't list ${id} models: ${message(e)}`);
    return [];
  }
}

/**
 * "Scan harnesses" (POST /api/llm/scan): which harnesses are installed, and each one's models listed afresh, all
 * at once. A harness that can't list its models (Grok timing out…) comes back with `error` and no models.
 */
export async function scanHarnesses(
  status: () => ProviderInfo[] = providerStatus, models: (id: LlmProvider) => Promise<LlmModelInfo[]> = freshModels,
): Promise<HarnessScan[]> {
  return Promise.all(status().map(async (p): Promise<HarnessScan> => {
    if (!p.available) return { ...p, models: [] };
    try { return { ...p, models: await models(p.id) }; } catch (e) {
      console.info(`[llm] scan: couldn't list ${p.id} models: ${message(e)}`);
      return { ...p, models: [], error: message(e) };
    }
  }));
}

export const isProvider = (v: string): v is LlmProvider => isLlmProvider(v);
