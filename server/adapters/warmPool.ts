import type { DrawingAnnotation } from "../../shared/annotations.ts";
// Warm agents for the model tiers. Each role (router and progress lines on the fast tier, the solver on the
// smart tier) keeps a pool of agents already started with its harness, model, level, speed and system prompt
// (harnesses.ts), so a request doesn't pay the harness's start-up; taking one starts its replacement.
// `configureWarm(selection)` is called at server start (the saved selection) and whenever the Chat page
// changes a tier: pools for anything else are killed, the selected ones started. A request for a choice
// without a pool (a turn sent with another config) starts one on the spot, so only its first request is cold.
// Element threads take their agents here too (`takeThreadAgent`): kept across requests, never back in a pool.
// A fast tier on a model API (llmApi.ts) has nothing to warm: its roles get no pool.
import { cleanToggles, isHarness, LLM_PROVIDER_LABELS, type HarnessId, type LlmChoice, type LlmTier } from "../../shared/config.ts";
import type { CliRole } from "./claudeCli.ts";
import { AGENT_FACTORIES, KEEPS_POOLED, stopSharedServers, type AgentFactory, type AgentSpec, type HarnessResult, type WarmAgent } from "./harnesses.ts";

/** Agents kept waiting per pool. Codex threads and opencode sessions are cheap; Grok can't be pre-started. */
export const POOL_SIZE: Record<HarnessId, number> = { "claude-code": 1, codex: 2, grok: 0, opencode: 2, pi: 1, omp: 1 };

/** The tier each role runs on. */
export const ROLE_TIER: Record<CliRole, LlmTier> = { router: "fast", fillers: "fast", solver: "smart" };

let log: (msg: string) => void = (msg) => console.info(msg);
export function setWarmLogger(fn: (msg: string) => void): void { log = fn; }

/** The system prompt and project folder of each role on a harness (registered by claude.ts). */
type SpecSource = (role: CliRole, harness: HarnessId) => { system: string; project?: string };
let specSource: SpecSource | null = null;
export function registerRoleSpecs(fn: SpecSource): void { specSource = fn; }

/** Tests: replace how agents are made (default: the real harnesses). */
let factory: AgentFactory = (s, keep) => AGENT_FACTORIES[s.harness](s, keep);
export function setAgentFactory(fn: AgentFactory | null): void {
  factory = fn ?? ((s, keep) => AGENT_FACTORIES[s.harness](s, keep));
}

export function agentSpec(role: CliRole, choice: LlmChoice): AgentSpec {
  if (!specSource) throw new Error("role prompts not registered");
  const harness = choice.provider;
  if (!isHarness(harness)) throw new Error(`${LLM_PROVIDER_LABELS[harness]} is a model API, not a harness: it can't run the ${role}`);
  const { system, project } = specSource(role, harness);
  const toggles = cleanToggles(harness, choice.toggles);
  return {
    role, harness, model: choice.model,
    ...(choice.level ? { level: choice.level } : {}), ...(choice.speed === "fast" ? { speed: "fast" as const } : {}),
    ...(toggles ? { toggles } : {}),
    system, ...(role === "solver" && project ? { project } : {}),
  };
}

const keyOf = (s: AgentSpec): string => JSON.stringify([s.role, s.harness, s.model, s.level ?? "", s.speed ?? "", s.toggles ?? {}, s.project ?? "", s.system]);

class Pool {
  private idle: WarmAgent[] = [];
  private stopped = false;
  constructor(readonly spec: AgentSpec, private size: number) {}

  fill(): void {
    if (this.stopped) return;
    this.idle = this.idle.filter((a) => a.alive());
    while (this.idle.length < this.size) {
      try {
        this.idle.push(factory(this.spec));
      } catch (e) {
        log(`[agents] can't start ${label(this.spec)}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
  }

  /** A waiting agent (or a new one if none is ready to go), and a replacement starts in the background. */
  take(): WarmAgent {
    this.idle = this.idle.filter((a) => a.alive());
    const i = this.idle.findIndex((a) => a.ready());
    const agent = i >= 0 ? this.idle.splice(i, 1)[0]! : this.idle.shift() ?? factory(this.spec);
    queueMicrotask(() => this.fill());
    return agent;
  }

  get waiting(): number { return this.idle.filter((a) => a.alive()).length; }
  get readyCount(): number { return this.idle.filter((a) => a.alive() && a.ready()).length; }

  stop(): void {
    this.stopped = true;
    for (const a of this.idle) a.kill();
    this.idle = [];
  }
}

const label = (s: AgentSpec): string =>
  `${s.role} on ${LLM_PROVIDER_LABELS[s.harness]} ${s.model || "(default model)"}${s.level ? ` · ${s.level}` : ""}${s.speed === "fast" ? " · fast" : ""}`;

const pools = new Map<string, Pool>();
/** Requests in flight per harness: a shared server isn't stopped under them. */
const inflight = new Map<HarnessId, number>();
/** Element-thread agents (alive or not yet released): their shared server stays up; killed by stopWarm. */
const kept = new Map<WarmAgent, HarnessId>();
let exitHooked = false;

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.once("exit", stopWarm);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { stopWarm(); process.exit(0); });
}

function releaseShared(): void {
  const inUse = new Set<HarnessId>([...pools.values()].map((p) => p.spec.harness));
  for (const [h, n] of inflight) if (n > 0) inUse.add(h);
  for (const [a, h] of kept) { if (a.alive()) inUse.add(h); else kept.delete(a); }
  stopSharedServers(inUse);
}

/**
 * Keep agents warm for exactly this selection: kill every other pool (and the shared Codex / opencode
 * servers if nothing uses them any more), start the missing ones.
 */
export function configureWarm(selection: Record<LlmTier, LlmChoice>): void {
  hookExit();
  const wanted = new Map<string, AgentSpec>();
  for (const role of ["router", "fillers", "solver"] as const) {
    const choice = selection[ROLE_TIER[role]];
    if (!isHarness(choice.provider)) continue;
    const spec = agentSpec(role, choice);
    wanted.set(keyOf(spec), spec);
  }
  for (const [key, pool] of pools) {
    if (!wanted.has(key)) { pool.stop(); pools.delete(key); }
  }
  releaseShared();
  const started: string[] = [];
  for (const [key, spec] of wanted) {
    if (pools.has(key)) continue;
    const pool = new Pool(spec, POOL_SIZE[spec.harness]);
    pools.set(key, pool);
    pool.fill();
    started.push(`${label(spec)} ×${POOL_SIZE[spec.harness]}`);
  }
  if (started.length) log(`[agents] warming: ${started.join(", ")}`);
}

/**
 * One request on a warm agent for `role` with `choice` (a pool is started for it if there isn't one). `signal`
 * aborted: the agent is killed and this rejects at once.
 */
export async function harnessRequest(
  role: CliRole, choice: LlmChoice, user: string, onText: ((d: string) => void) | undefined, timeoutMs: number, signal?: AbortSignal, annotations?: readonly DrawingAnnotation[],
): Promise<HarnessResult> {
  signal?.throwIfAborted();
  hookExit();
  const spec = agentSpec(role, choice);
  const key = keyOf(spec);
  let pool = pools.get(key);
  if (!pool) {
    pool = new Pool(spec, POOL_SIZE[spec.harness]);
    pools.set(key, pool);
  }
  const agent = pool.take();
  const h = spec.harness;
  inflight.set(h, (inflight.get(h) ?? 0) + 1);
  let onAbort: (() => void) | null = null;
  try {
    const request = agent.request(user, signal ? (d) => { if (!signal.aborted) onText?.(d); } : onText, timeoutMs, annotations);
    if (!signal) return await request;
    request.catch(() => {}); // aborted: nobody waits for it any more
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => { agent.kill(); reject(signal.reason ?? new Error("aborted")); };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([request, aborted]);
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    inflight.set(h, (inflight.get(h) ?? 1) - 1);
  }
}

/**
 * Element threads: an agent for `role` with `choice` that keeps its session across requests. Taken from the warm
 * pool when its harness can keep a pooled agent (a warm first request; a replacement starts), else started now.
 * It never goes back to a pool. Hand it to `releaseThreadAgent` when done; stopWarm kills it.
 */
export function takeThreadAgent(role: CliRole, choice: LlmChoice): WarmAgent {
  hookExit();
  const spec = agentSpec(role, choice);
  const pool = pools.get(keyOf(spec));
  let agent: WarmAgent | null = null;
  if (pool && KEEPS_POOLED.has(spec.harness)) {
    const a = pool.take();
    if (a.keep?.()) agent = a;
    else a.kill();
  }
  agent ??= factory(spec, true);
  kept.set(agent, spec.harness);
  return agent;
}

/** Kill an element-thread agent and stop the shared server it used if nothing else does. */
export function releaseThreadAgent(agent: WarmAgent): void {
  agent.kill();
  if (kept.delete(agent)) releaseShared();
}

/** Every warm pool: role, harness, model, and how many agents wait (and of those, how many finished starting). */
export function warmStatus(): { role: CliRole; harness: HarnessId; model: string; level?: string; speed?: string; waiting: number; ready: number }[] {
  return [...pools.values()].map((p) => ({
    role: p.spec.role, harness: p.spec.harness, model: p.spec.model,
    ...(p.spec.level ? { level: p.spec.level } : {}), ...(p.spec.speed ? { speed: p.spec.speed } : {}),
    waiting: p.waiting, ready: p.readyCount,
  }));
}

/** Kill every warm agent and shared server (process exit, tests). */
export function stopWarm(): void {
  for (const p of pools.values()) p.stop();
  pools.clear();
  for (const a of kept.keys()) a.kill();
  kept.clear();
  stopSharedServers(new Set());
}
