// Benchmark: the model tiers on warm agents vs cold ones, for one tier selection. Router, progress lines and
// solver, N runs each, sequential; prints first token / decision / spoken line / total per variant.
//   npm run bench:harness                                   (the saved selection: what the Chat page last picked)
//   npm run bench:harness -- --fast codex:gpt-6-luna:low --smart codex:gpt-6.1-sol:medium:fast --router 6 --solver 2
// A tier is provider:model[:level[:fast]] ("/" in the model is fine); the fast tier's provider can be a model API
// (openrouter, cerebras…: no agent, so warm and cold are the same request). Cold = a new agent per call.
import { loadDesktopEnv } from "../electron/settings.ts";
import { generateFillers, routeTurn, setLogger, solveTask } from "../server/adapters/claude.ts";
import { configureWarm, setWarmLogger, stopWarm } from "../server/adapters/warmPool.ts";
import { currentSelection } from "../server/llmSelection.ts";
import { loadPriceCatalog } from "../server/prices.ts";
import { isLlmProvider, type LlmChoice, type LlmTier } from "../shared/config.ts";
import type { PointingTarget } from "../shared/protocol.ts";

loadDesktopEnv(); // the API keys saved in Settings (a shell variable wins)

const argOf = (k: string): string | undefined => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const N = { router: Number(argOf("router") ?? 5), fillers: Number(argOf("fillers") ?? 3), solver: Number(argOf("solver") ?? 2) };
const GAP_MS = 2500; // between runs: lets the replacement agent start

function parseTier(v: string | undefined, fallback: LlmChoice): LlmChoice {
  if (!v) return fallback;
  const [provider, model = "", level, speed] = v.split(":");
  if (!provider || !isLlmProvider(provider)) throw new Error(`unknown harness or API in ${v}`);
  return { provider, model, ...(level ? { level } : {}), ...(speed === "fast" ? { speed: "fast" as const } : {}) };
}
const saved = currentSelection();
const sel: Record<LlmTier, LlmChoice> = { fast: parseTier(argOf("fast"), saved.fast), smart: parseTier(argOf("smart"), saved.smart) };

const TRANSCRIPT = "Why is this [1] section built with a grid instead of flexbox?";
const POINTING: PointingTarget[] = [{
  word: "this", wordStart: 0.6, algorithm: "dwellMode", ref: 1, wordIndex: 2,
  sample: { t: 0, x: 0, y: 0, scrollX: 0, scrollY: 0, elementPath: "main > section#features > div.card-grid", dataSource: "demo.html:34", label: "Feature card grid", container: "Features section" },
}];
const QUESTION = "Why is the feature card grid (data-source demo.html:34) built with CSS grid instead of flexbox?";

type Variant = "warm" | "cold";
interface Run { variant: Variant; role: string; first: number | null; mid: number | null; total: number; warmAgent?: boolean; error?: string }
const runs: Run[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** warm: pools for the selection, given time to start. cold: no pools; each call starts its agent. */
async function before(v: Variant): Promise<void> {
  stopWarm();
  if (v === "warm") { configureWarm(sel); await sleep(GAP_MS); }
}

async function one(v: Variant, role: "router" | "fillers" | "solver"): Promise<void> {
  await before(v);
  const t0 = performance.now();
  const since = () => performance.now() - t0;
  let first: number | null = null, mid: number | null = null, warmAgent: boolean | undefined;
  const onResponse = (r: { raw?: unknown }) => { warmAgent = (r.raw as { warmAgent?: boolean } | undefined)?.warmAgent; };
  try {
    if (role === "router") {
      await routeTurn({
        mark: (n) => { if (n === "llm.firstToken") first ??= since(); }, transcript: TRANSCRIPT, pointing: POINTING, mode: "forced", llm: sel.fast,
        onDecision: () => { mid ??= since(); }, onSpokenDelta: () => {}, onResponse,
      });
    } else if (role === "fillers") {
      const r = await generateFillers({ transcript: TRANSCRIPT, question: QUESTION, intent: "question", pointing: POINTING, llm: sel.fast, onResponse });
      if (!r.lines.length) throw new Error("no lines");
    } else {
      await solveTask({
        mark: (n) => { if (n === "solver.firstToken") first ??= since(); }, question: QUESTION, pointing: POINTING, fast: false, llm: sel.smart,
        onSpokenLine: () => { mid ??= since(); }, onDelta: () => {}, onResponse,
      });
    }
    runs.push({ variant: v, role, first, mid, total: since(), warmAgent });
  } catch (e) {
    runs.push({ variant: v, role, first, mid, total: since(), error: e instanceof Error ? e.message : String(e) });
  }
  const r = runs.at(-1)!;
  console.log(`  ${v} ${role}: first ${fmt(r.first)} · ${role === "solver" ? "spoken" : "decision"} ${fmt(r.mid)} · total ${fmt(r.total)} ms${r.error ? ` ERROR ${r.error}` : ""}`);
}

const fmt = (x: number | null | undefined) => (typeof x === "number" ? `${Math.round(x)}` : "–");
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN; };

async function main(): Promise<void> {
  setLogger(() => {});
  setWarmLogger(() => {});
  await loadPriceCatalog(() => {});
  const show = (c: LlmChoice) => `${c.provider} ${c.model || "(default)"}${c.level ? ` · ${c.level}` : ""}${c.speed === "fast" ? " · fast" : ""}`;
  console.log(`fast tier: ${show(sel.fast)}\nsmart tier: ${show(sel.smart)}`);
  for (const v of ["warm", "cold"] as const) {
    console.log(`\n== ${v}`);
    for (let i = 0; i < N.router; i++) { await one(v, "router"); await sleep(GAP_MS); }
    for (let i = 0; i < N.fillers; i++) { await one(v, "fillers"); await sleep(GAP_MS); }
    for (let i = 0; i < N.solver; i++) { await one(v, "solver"); await sleep(GAP_MS); }
  }
  stopWarm();
  console.log("\n| role · variant | first token p50 | decision / spoken p50 | total p50 | warm agent | errors |\n|---|---|---|---|---|---|");
  for (const role of ["router", "fillers", "solver"]) for (const v of ["warm", "cold"] as const) {
    const all = runs.filter((r) => r.role === role && r.variant === v);
    const ok = all.filter((r) => !r.error);
    const nums = (k: "first" | "mid" | "total") => ok.map((r) => r[k]).filter((x): x is number => typeof x === "number");
    console.log(`| ${role} · ${v} | ${fmt(median(nums("first")))} | ${fmt(median(nums("mid")))} | ${fmt(median(nums("total")))} | ${ok.filter((r) => r.warmAgent).length}/${ok.length} | ${all.length - ok.length} |`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); stopWarm(); process.exit(1); });
