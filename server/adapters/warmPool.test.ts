import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { LlmChoice, LlmTier } from "../../shared/config.ts";
import type { AgentSpec, HarnessResult, WarmAgent } from "./harnesses.ts";
import { configureWarm, harnessRequest, registerRoleSpecs, setAgentFactory, setWarmLogger, stopWarm, warmStatus } from "./warmPool.ts";

const FAKE = fileURLToPath(new URL("./__fixtures__/fake-claude.mjs", import.meta.url));
const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); } };
const CLAUDE: Record<LlmTier, LlmChoice> = {
  fast: { provider: "claude-code", model: "claude-haiku-5-5", level: "low" },
  smart: { provider: "claude-code", model: "claude-opus-5-5", level: "medium" },
};

setWarmLogger(() => {});
beforeEach(() => registerRoleSpecs((role) => ({ system: `${role.toUpperCase()} system` })));
afterEach(() => { stopWarm(); setAgentFactory(null); vi.unstubAllEnvs(); });

describe("warm claude -p agents (fake CLI)", () => {
  it("keeps one agent waiting per role, answers from it, and replaces it as soon as it's taken", async () => {
    vi.stubEnv("CLAUDE_BIN", FAKE);
    configureWarm(CLAUDE);
    expect(warmStatus().map((p) => [p.role, p.waiting])).toEqual([["router", 1], ["fillers", 1], ["solver", 1]]);
    await until(() => warmStatus().every((p) => p.ready === 1));
    const deltas: string[] = [];
    const r = await harnessRequest("router", CLAUDE.fast, "hello there", (d) => deltas.push(d), 5000);
    expect(r.text).toBe("ROUTER: hello there");
    expect(deltas.join("")).toBe(r.text);
    expect(deltas.length).toBeGreaterThan(1); // streamed in chunks
    expect(r).toMatchObject({ stopReason: "end_turn", model: "claude-haiku-5-5", usage: { input_tokens: 10, output_tokens: 5 }, warm: true });
    await until(() => warmStatus().find((p) => p.role === "router")!.waiting === 1); // replacement already waiting
    expect((await harnessRequest("solver", CLAUDE.smart, "why grid?", undefined, 5000)).text).toBe("SOLVER: why grid?");
  });

  it("a choice without a pool gets one on its first request (a cold start)", async () => {
    vi.stubEnv("CLAUDE_BIN", FAKE);
    const r = await harnessRequest("fillers", { provider: "claude-code", model: "claude-sonnet-5-5" }, "x", undefined, 5000);
    expect(r.warm).toBe(false);
    expect(r.text).toBe("FILLERS: x");
    expect(warmStatus()).toMatchObject([{ role: "fillers", model: "claude-sonnet-5-5" }]);
  });
});

describe("re-warming on a new selection", () => {
  class Agent implements WarmAgent {
    killed = false;
    constructor(readonly spec: AgentSpec) { made.push(this); }
    alive() { return !this.killed; }
    ready() { return true; }
    async request(): Promise<HarnessResult> { return { text: "", stopReason: "end_turn", model: this.spec.model, usage: {}, raw: null, warm: true }; }
    kill() { this.killed = true; }
  }
  let made: Agent[] = [];
  beforeEach(() => { made = []; setAgentFactory((s) => new Agent(s)); });

  it("kills the agents of the old choice and starts the new ones; an unchanged tier keeps its agents", () => {
    configureWarm(CLAUDE);
    const first = [...made];
    expect(first.map((a) => a.spec.role)).toEqual(["router", "fillers", "solver"]);
    configureWarm({ ...CLAUDE, fast: { provider: "codex", model: "gpt-6-astra", level: "low", speed: "fast" } });
    expect(first.filter((a) => a.killed).map((a) => a.spec.role)).toEqual(["router", "fillers"]);
    expect(first.find((a) => a.spec.role === "solver")!.killed).toBe(false);
    const codex = made.filter((a) => a.spec.harness === "codex");
    expect(codex).toHaveLength(4); // two threads per role
    expect(codex[0]!.spec).toMatchObject({ model: "gpt-6-astra", level: "low", speed: "fast" });
    expect(warmStatus().map((p) => `${p.role}:${p.harness}`).sort()).toEqual(["fillers:codex", "router:codex", "solver:claude-code"]);
  });

  it("Grok keeps no agents waiting (it can't be started ahead)", () => {
    configureWarm({ fast: { provider: "grok", model: "grok-4.7-build-fast" }, smart: CLAUDE.smart });
    expect(made.filter((a) => a.spec.harness === "grok")).toHaveLength(0);
  });
});
