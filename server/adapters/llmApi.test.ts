import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultLevel, llmOf, type LlmChoice } from "../../shared/config.ts";
import type { LlmPrompt, LlmResponse } from "../../shared/protocol.ts";
import { generateFillers, routeTurn, setLogger } from "./claude.ts";
import { anthropicThinking, reasoningParams, setAnthropicFactory, setApiFetch } from "./llmApi.ts";
import type { AgentSpec, WarmAgent } from "./harnesses.ts";
import { configureWarm, setAgentFactory, stopWarm } from "./warmPool.ts";
import { catalogModelInfo, setPriceCatalog } from "../prices.ts";
import { providerStatus } from "../llmProviders.ts";

const ROUTE = { intent: "question", estimate_seconds: 8, say: "Let me look at that grid.", question: "What font does the card grid use?" };
const KEYS = ["OPENROUTER_API_KEY", "CEREBRAS_API_KEY", "ANTHROPIC_API_KEY", "ZAI_API_KEY", "FIREWORKS_API_KEY", "OPENAI_API_KEY"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  setLogger(() => {});
  for (const k of KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  setApiFetch(null);
  setAnthropicFactory(null);
  setPriceCatalog(null);
  setAgentFactory(null);
  stopWarm();
  for (const k of KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

/** An SSE response streaming `events` as `data:` lines, a few bytes at a time (lines split across reads). */
function sse(events: unknown[], status = 200): Response {
  const text = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(": keep-alive comment\n\n" + text);
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= bytes.length) { c.close(); return; }
      c.enqueue(bytes.slice(i, i + 17));
      i += 17;
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

/** The router's JSON split into content deltas, after some reasoning deltas that must not reach the parser. */
function routeEvents(json: string, usage: Record<string, unknown>): unknown[] {
  const deltas: unknown[] = [
    { model: "gpt-oss-120b", choices: [{ delta: { reasoning: "The user points at the grid {not json}" } }] },
    { choices: [{ delta: { reasoning_content: "so it's a question." } }] },
  ];
  for (let i = 0; i < json.length; i += 7) deltas.push({ choices: [{ delta: { content: json.slice(i, i + 7) } }] });
  deltas.push({ choices: [{ delta: {}, finish_reason: "stop" }] });
  deltas.push({ choices: [], usage });
  return deltas;
}

interface Captured { url: string; headers: Record<string, string>; body: Record<string, unknown> }
function fakeFetch(respond: () => Response): Captured[] {
  const calls: Captured[] = [];
  setApiFetch((async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return respond();
  }) as typeof fetch);
  return calls;
}

async function route(llm: LlmChoice, history: { user: string; assistant: string }[] = []) {
  const spoken: string[] = [];
  const decisions: unknown[] = [];
  const prompts: LlmPrompt[] = [];
  const responses: LlmResponse[] = [];
  const marks: string[] = [];
  const res = await routeTurn({
    mark: (n) => { marks.push(n); }, transcript: "What font is this [1] grid?", pointing: [], mode: "forced", llm,
    history: history.map((h, i) => ({ turnId: `t${i}`, approach: "pipeline" as const, detail: "", ...h })) as never,
    onDecision: (d) => decisions.push(d), onSpokenDelta: (d) => spoken.push(d),
    onPrompt: (p) => prompts.push(p), onResponse: (r) => responses.push(r),
  });
  return { res, said: spoken.join(""), decisions, prompts, responses, marks };
}

describe("router on a Chat Completions API", () => {
  it("Cerebras: system prompt + real messages, reasoning level, only the answer streams, usage priced from the catalog", async () => {
    process.env.CEREBRAS_API_KEY = "csk-test";
    setPriceCatalog({ "cerebras/gpt-oss-120b": { input: 0.35, output: 0.75 } });
    const calls = fakeFetch(() => sse(routeEvents(JSON.stringify(ROUTE), { prompt_tokens: 3000, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 2000 } })));
    const { res, said, decisions, prompts, responses, marks } = await route({ provider: "cerebras", model: "gpt-oss-120b", level: "low" });

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect(c.headers.authorization).toBe("Bearer csk-test");
    expect(c.body).toMatchObject({ model: "gpt-oss-120b", stream: true, stream_options: { include_usage: true }, max_tokens: 4096, reasoning_effort: "low" });
    const msgs = c.body.messages as { role: string; content: string }[];
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("Reply with ONLY one JSON object");
    expect(msgs.at(-1)).toMatchObject({ role: "user" });
    expect(msgs.at(-1)!.content).toContain("What font is this [1] grid?");

    expect(decisions[0]).toMatchObject({ intent: "question", estimateS: 8 });
    expect(said).toBe(ROUTE.say);
    expect(res.delegate).toMatchObject({ question: ROUTE.question, intent: "question" });
    // 3000 prompt tokens, 2000 of them cached: 1000 at the input price, 2000 at the input price (no cache price listed).
    expect(res.usage).toMatchObject({ input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 60, llmCost: { billing: "api" } });
    expect((res.usage as { llmCost: { usd: number } }).llmCost.usd).toBeCloseTo((3000 * 0.35 + 60 * 0.75) / 1e6, 10);
    expect(marks).toContain("llm.firstToken");
    expect(prompts[0]!.model).toBe("gpt-oss-120b via Cerebras API");
    expect(prompts[0]!.messages.at(-1)!.label).toBe("this turn");
    expect(responses[0]).toMatchObject({ billing: "api", stopReason: "end_turn", model: "gpt-oss-120b" });
  });

  it("earlier turns go as user / assistant messages, not flattened", async () => {
    process.env.CEREBRAS_API_KEY = "k";
    const calls = fakeFetch(() => sse(routeEvents(JSON.stringify(ROUTE), {})));
    await route({ provider: "cerebras", model: "gpt-oss-120b" }, [{ user: "Make the header blue", assistant: "Sure, I'll make it blue." }]);
    const msgs = calls[0]!.body.messages as { role: string; content: string }[];
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(calls[0]!.body.reasoning_effort).toBeUndefined();
  });

  it("OpenRouter: its reported cost wins; reasoning off; OpenAI takes max_completion_tokens", async () => {
    process.env.OPENROUTER_API_KEY = "or";
    process.env.OPENAI_API_KEY = "oa";
    const calls = fakeFetch(() => sse(routeEvents(JSON.stringify(ROUTE), { prompt_tokens: 100, completion_tokens: 10, cost: 0.000123 })));
    const { res } = await route({ provider: "openrouter", model: "anthropic/claude-haiku-5.5", level: "off" });
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]!.body.reasoning).toEqual({ enabled: false });
    expect((res.usage as { llmCost: { usd: number } }).llmCost.usd).toBe(0.000123);

    await route({ provider: "openai", model: "gpt-6-luna", level: "none" });
    expect(calls[1]!.body).toMatchObject({ max_completion_tokens: 4096, reasoning_effort: "none" });
    expect(calls[1]!.body.max_tokens).toBeUndefined();
  });

  it("an HTTP error surfaces with the API's message; a missing key points to Settings", async () => {
    process.env.FIREWORKS_API_KEY = "bad";
    fakeFetch(() => new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }));
    await expect(route({ provider: "fireworks", model: "accounts/fireworks/models/gpt-oss-120b" })).rejects.toThrow("Fireworks API HTTP 401: invalid api key");
    await expect(route({ provider: "zai", model: "glm-5.3-flash" })).rejects.toThrow(/Settings → API keys/);
  });

  it("a request that never answers is aborted at its timeout and reported as one", async () => {
    process.env.CEREBRAS_API_KEY = "k";
    setApiFetch(((_u: string, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch);
    const { apiRequest } = await import("./llmApi.ts");
    await expect(apiRequest("cerebras", { provider: "cerebras", model: "gpt-oss-120b" }, { system: "s", messages: [{ role: "user", content: "u" }] }, undefined, 30))
      .rejects.toThrow("Cerebras API timed out after 30 ms");
  });

  it("progress lines run on the API too", async () => {
    process.env.CEREBRAS_API_KEY = "k";
    const calls = fakeFetch(() => sse([{ choices: [{ delta: { content: '{"lines": ["Checking the grid.", "Almost there."]}' }, finish_reason: "stop" }] }]));
    const r = await generateFillers({ transcript: "why", question: "Why grid?", intent: "question", pointing: [], llm: { provider: "cerebras", model: "gpt-oss-120b" } });
    expect(r.lines).toEqual(["Checking the grid.", "Almost there."]);
    expect((calls[0]!.body.messages as { content: string }[])[0]!.content).toContain('{"lines"');
  });
});

describe("router on the Anthropic API", () => {
  it("cached system prompt, thinking off, streamed text, usage priced as Haiku", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    let params: Record<string, unknown> | null = null;
    let key = "";
    const json = JSON.stringify(ROUTE);
    setAnthropicFactory((k) => {
      key = k;
      return {
        messages: {
          stream: (p: Record<string, unknown>) => {
            params = p;
            const handlers: ((d: string) => void)[] = [];
            return {
              on(ev: string, cb: (d: string) => void) { if (ev === "text") handlers.push(cb); return this; },
              async finalMessage() {
                for (let i = 0; i < json.length; i += 9) for (const h of handlers) h(json.slice(i, i + 9));
                return { id: "msg_1", model: "claude-haiku-5-5", stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 40, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 } };
              },
            };
          },
        },
      } as never;
    });
    const { res, said } = await route({ provider: "anthropic", model: "claude-haiku-5-5", level: "off" });
    expect(key).toBe("sk-ant");
    expect(params).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 4096, thinking: { type: "disabled" } });
    expect((params!.system as { cache_control: unknown }[])[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(said).toBe(ROUTE.say);
    expect(res.delegate?.question).toBe(ROUTE.question);
    // Haiku 5.5: $0.10 in, $0.50 out, cache reads at 0.1× input.
    expect((res.usage as { llmCost: { usd: number } }).llmCost.usd).toBeCloseTo((50 * 0.1 + 3000 * 0.01 + 40 * 0.5) / 1e6, 10);
  });

  it("levels: off → thinking disabled, an effort → adaptive at that effort", () => {
    expect(anthropicThinking(undefined)).toEqual({});
    expect(anthropicThinking("off")).toEqual({ thinking: { type: "disabled" } });
    expect(anthropicThinking("low")).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "low" } });
  });
});

describe("reasoning levels", () => {
  it("map to each API's field", () => {
    expect(reasoningParams("zai", "off")).toEqual({ thinking: { type: "disabled" } });
    expect(reasoningParams("zai", "high")).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });
    expect(reasoningParams("openrouter", "medium")).toEqual({ reasoning: { effort: "medium" } });
    expect(reasoningParams("fireworks", "low")).toEqual({ reasoning_effort: "low" });
    expect(reasoningParams("cerebras", undefined)).toEqual({});
  });

  it("come from the catalog's reasoning options; a model that can turn reasoning off starts the fast tier off", () => {
    const haiku = catalogModelInfo("claude-haiku-5-5", [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "high"] }]);
    expect(haiku).toMatchObject({ levels: ["off", "low", "medium", "high"], fastLevel: "off" });
    expect(defaultLevel(haiku, "fast")).toBe("off");
    expect(defaultLevel(haiku, "smart")).toBe("medium");
    expect(catalogModelInfo("glm", [{ type: "toggle" }]).levels).toEqual(["off", "on"]);
    expect(catalogModelInfo("gpt", [{ type: "effort", values: ["none", "low", "high"] }])).toMatchObject({ levels: ["none", "low", "high"], fastLevel: "none" });
    const oss = catalogModelInfo("gpt-oss-120b", [{ type: "effort", values: ["low", "medium", "high"] }]);
    expect(oss.fastLevel).toBeUndefined();
    expect(defaultLevel(oss, "fast")).toBe("low");
    expect(catalogModelInfo("plain", []).levels).toEqual([]);
  });
});

describe("tier selection with a model API", () => {
  it("an API is kept on the fast tier and dropped on the smart one", () => {
    const sel = llmOf({ llm: { fast: { provider: "cerebras", model: "gpt-oss-120b" }, smart: { provider: "openrouter", model: "x" } } });
    expect(sel.fast.provider).toBe("cerebras");
    expect(sel.smart.provider).toBe("claude-code");
  });

  it("warming: no agents for a fast tier on an API, the solver's pool still starts", () => {
    const started: AgentSpec[] = [];
    setAgentFactory((s): WarmAgent => {
      started.push(s);
      return { alive: () => true, ready: () => true, request: async () => { throw new Error("no"); }, kill: () => {} };
    });
    configureWarm({ fast: { provider: "cerebras", model: "gpt-oss-120b" }, smart: { provider: "claude-code", model: "claude-opus-5-5" } });
    expect(started.map((s) => s.role)).toEqual(["solver"]);
  });

  it("an API is usable once its key is set", () => {
    process.env.CEREBRAS_API_KEY = "k";
    const apis = providerStatus().filter((p) => p.api);
    expect(apis.map((p) => p.id)).toEqual(["openrouter", "fireworks", "cerebras", "anthropic", "openai", "zai"]);
    expect(apis.find((p) => p.id === "cerebras")).toMatchObject({ available: true });
    expect(apis.find((p) => p.id === "zai")).toMatchObject({ available: false, note: expect.stringContaining("Z.ai API key") });
  });
});
