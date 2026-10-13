// Benchmark: Claude over the HTTP API (OpenRouter) vs `claude -p` agents (pre-spawned "warm", and spawned
// per call "cold"), on identical prompts. Router (Haiku), progress lines (Haiku) and Opus, N runs each,
// sequential; then full B-pipeline turns with real audio over /ws. Writes docs/BENCH-claude-backends.md
// and the raw runs to docs/report-data/bench-claude-backends.json.
//   npm run bench:claude                      (defaults: router 8, fillers 5, opus 4, e2e 3)
//   npm run bench:claude -- --router 4 --fillers 3 --opus 2 --e2e 2 --skip-e2e
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateFillers, hasClaudeCredentials, routeWithHaiku, setLogger, solveWithOpus } from "../server/adapters/claude.ts";
import { startClaudeAgents, stopClaudeAgents, setCliLogger } from "../server/adapters/claudeCli.ts";
import { callCost } from "../server/cost.ts";
import type { ClaudeBackend } from "../shared/config.ts";
import type { LlmResponse, PointingTarget } from "../shared/protocol.ts";

const arg = (k: string, d: number) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = { router: arg("router", 8), fillers: arg("fillers", 5), opus: arg("opus", 4), e2e: arg("e2e", 3) };
const SKIP_E2E = process.argv.includes("--skip-e2e");
const GAP_MS = 2500; // between runs: lets the replacement agent boot (and evens out the API runs)

if (!hasClaudeCredentials()) { console.log("SKIP bench:claude: OPENROUTER_API_KEY (or ANTHROPIC_API_KEY) not set"); process.exit(0); }
setLogger(() => {});
setCliLogger(() => {});

type Variant = "api" | "cli-warm" | "cli-cold";
const VARIANTS: Variant[] = ["api", "cli-warm", "cli-cold"];
const backendOf = (v: Variant): ClaudeBackend => (v === "api" ? "api" : "cli");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// U3 from PRD §5, pointing at the card grid.
const TRANSCRIPT = "Why is this [1] section built with a grid instead of flexbox?";
const POINTING: PointingTarget[] = [{
  word: "this", wordStart: 0.6, algorithm: "dwellMode", ref: 1, wordIndex: 2,
  sample: { t: 0, x: 0, y: 0, scrollX: 0, scrollY: 0, elementPath: "main > section#features > div.grid", dataSource: "web/cursor/demo/demo.html:34", label: "Feature card grid", container: "Features section" },
}];
const QUESTION = "Why is the feature card grid (data-source web/cursor/demo/demo.html:34) built with CSS grid instead of flexbox? Explain from the source and the recorded design decisions.";

interface Run { variant: Variant; role: string; i: number; ttft: number | null; decision?: number | null; ack?: number | null; spoken?: number | null; total: number; costUsd: number; cliCostUsd?: number; warm?: boolean; error?: string }
const runs: Run[] = [];

function setVariant(v: Variant): void {
  stopClaudeAgents();
  if (v === "cli-warm") startClaudeAgents({ sizes: { router: 1, fillers: 1, opus: 1 } });
  if (v === "cli-cold") startClaudeAgents({ sizes: { router: 0, fillers: 0, opus: 0 } });
}

const costOf = (r: LlmResponse | undefined, role: "router" | "fillers" | "opus") => (r?.usage ? callCost(role, r.usage, "gpt-realtime-2.1") : 0);
const cliCost = (r: LlmResponse | undefined) => (r?.raw as { cliCostUsd?: number } | undefined)?.cliCostUsd;
const warmOf = (r: LlmResponse | undefined) => (r?.raw as { warmAgent?: boolean } | undefined)?.warmAgent;

async function benchRouter(v: Variant, i: number): Promise<void> {
  const t0 = performance.now();
  let ttft: number | null = null, decision: number | null = null, ack: number | null = null;
  let resp: LlmResponse | undefined;
  try {
    await routeWithHaiku({
      mark: (n) => { if (n === "llm.firstToken" && ttft === null) ttft = performance.now() - t0; },
      transcript: TRANSCRIPT, pointing: POINTING, mode: "forced", backend: backendOf(v),
      onDecision: () => { decision ??= performance.now() - t0; },
      onSpokenDelta: () => {}, onSpokenEnd: () => { ack ??= performance.now() - t0; },
      onResponse: (r) => { resp = r; },
    });
    runs.push({ variant: v, role: "router", i, ttft, decision, ack, total: performance.now() - t0, costUsd: costOf(resp, "router"), cliCostUsd: cliCost(resp), warm: warmOf(resp) });
  } catch (e) {
    runs.push({ variant: v, role: "router", i, ttft, total: performance.now() - t0, costUsd: 0, error: String(e) });
  }
}

async function benchFillers(v: Variant, i: number): Promise<void> {
  const t0 = performance.now();
  let resp: LlmResponse | undefined;
  const r = await generateFillers({ transcript: TRANSCRIPT, question: QUESTION, intent: "question", pointing: POINTING, backend: backendOf(v), onResponse: (x) => { resp = x; } });
  runs.push({ variant: v, role: "fillers", i, ttft: null, total: performance.now() - t0, costUsd: costOf(resp, "fillers"), cliCostUsd: cliCost(resp), warm: warmOf(resp), ...(r.lines.length ? {} : { error: "no lines" }) });
}

async function benchOpus(v: Variant, i: number): Promise<void> {
  const t0 = performance.now();
  let ttft: number | null = null, spoken: number | null = null;
  let resp: LlmResponse | undefined;
  try {
    await solveWithOpus({
      mark: (n) => { if (n === "opus.firstToken" && ttft === null) ttft = performance.now() - t0; },
      question: QUESTION, pointing: POINTING, fast: false, backend: backendOf(v),
      onSpokenLine: () => { spoken ??= performance.now() - t0; }, onDelta: () => {}, onResponse: (r) => { resp = r; },
    });
    runs.push({ variant: v, role: "opus", i, ttft, spoken, total: performance.now() - t0, costUsd: costOf(resp, "opus"), cliCostUsd: cliCost(resp), warm: warmOf(resp) });
  } catch (e) {
    runs.push({ variant: v, role: "opus", i, ttft, total: performance.now() - t0, costUsd: 0, error: String(e) });
  }
}

// ── end-to-end B turns over /ws ──
interface E2E { variant: Variant; i: number; ttfa: number | null; tta: number | null; llmFirst: number | null; opusFirst: number | null; opusSpoken: number | null; costUsd: number; error?: string }
const e2e: E2E[] = [];

async function benchE2E(v: Variant, i: number, wavPath: string): Promise<void> {
  const { default: WebSocket } = await import("ws");
  const { startServer } = await import("../server/index.ts");
  const { parseWav } = await import("../server/wav.ts");
  const { DEFAULT_CONFIG } = await import("../shared/config.ts");
  const server = await startServer(0, { quiet: true, persist: false });
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
  await new Promise((r) => ws.once("open", r));
  const turnId = `e2e-${v}-${i}`;
  const done = new Promise<any>((res) => ws.on("message", (d, bin) => {
    if (bin) return;
    const m = JSON.parse(d.toString());
    if (m.turnId !== turnId) return;
    if (m.type === "audio.segment" && m.state === "start") ws.send(JSON.stringify({ type: "audio.played", turnId, segment: m.segment, tPlayed: performance.now() }));
    if (m.type === "turn.done") res(m.run);
  }));
  const wav = parseWav(readFileSync(wavPath));
  const t0 = performance.now();
  ws.send(JSON.stringify({ type: "turn.start", turnId, config: { ...DEFAULT_CONFIG, approach: "pipeline", routerMode: "forced", claudeBackend: backendOf(v), fillers: false }, tPress: t0 }));
  ws.send(JSON.stringify({ type: "turn.audioStart", turnId, tAudioStart: t0 }));
  for (let off = 0, j = 0; off < wav.data.length; off += 960, j++) {
    ws.send(wav.data.subarray(off, off + 960));
    const w = t0 + (j + 1) * 20 - performance.now(); if (w > 0) await sleep(w);
  }
  ws.send(JSON.stringify({ type: "turn.release", turnId, tRelease: performance.now() }));
  const run = await done;
  e2e.push({ variant: v, i, ttfa: run.metrics.ttfa, tta: run.metrics.tta, llmFirst: run.metrics.llmFirst, opusFirst: run.metrics.opusFirst, opusSpoken: run.metrics.opusSpoken, costUsd: run.costUsd, error: run.error });
  ws.close();
  await server.close();
}

// ── stats & report ──
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const k = (s.length - 1) * p, f = Math.floor(k), c = Math.ceil(k);
  return s[f]! + (s[c]! - s[f]!) * (k - f);
};
const ms = (x: number) => (Number.isFinite(x) ? `${Math.round(x)}` : "–");
const usd = (x: number) => (Number.isFinite(x) ? `$${x < 0.01 ? x.toFixed(5) : x.toFixed(4)}` : "–");
function row(label: string, xs: (number | null | undefined)[]): string {
  const v = xs.filter((x): x is number => typeof x === "number");
  return `| ${label} | ${ms(pct(v, 0.5))} | ${ms(pct(v, 0.9))} | ${ms(v.reduce((a, b) => a + b, 0) / (v.length || 1))} | ${v.length} |`;
}

async function main(): Promise<void> {
  const started = new Date().toISOString();
  for (const v of VARIANTS) {
    setVariant(v);
    if (v === "cli-warm") await sleep(3000); // let the pools boot
    console.log(`\n== ${v}`);
    for (let i = 0; i < N.router; i++) { await benchRouter(v, i); console.log(`  router ${i}: ${ms(runs.at(-1)!.total)} ms${runs.at(-1)!.error ? ` ERROR ${runs.at(-1)!.error}` : ""}`); await sleep(GAP_MS); }
    for (let i = 0; i < N.fillers; i++) { await benchFillers(v, i); console.log(`  fillers ${i}: ${ms(runs.at(-1)!.total)} ms`); await sleep(GAP_MS); }
    for (let i = 0; i < N.opus; i++) { await benchOpus(v, i); console.log(`  opus ${i}: ${ms(runs.at(-1)!.total)} ms${runs.at(-1)!.error ? ` ERROR ${runs.at(-1)!.error}` : ""}`); await sleep(GAP_MS); }
  }
  const wav = new URL("../fixtures/smoke/bench-question.wav", import.meta.url).pathname;
  if (!SKIP_E2E) {
    for (const v of ["api", "cli-warm"] as Variant[]) {
      setVariant(v);
      if (v === "cli-warm") await sleep(3000);
      for (let i = 0; i < N.e2e; i++) {
        try { await benchE2E(v, i, wav); } catch (e) { e2e.push({ variant: v, i, ttfa: null, tta: null, llmFirst: null, opusFirst: null, opusSpoken: null, costUsd: 0, error: String(e) }); }
        const r = e2e.at(-1)!;
        console.log(`  e2e ${v} ${i}: ttfa ${ms(r.ttfa ?? NaN)} tta ${ms(r.tta ?? NaN)}${r.error ? ` ERROR ${r.error}` : ""}`);
        await sleep(GAP_MS);
      }
    }
  }
  stopClaudeAgents();

  const by = (v: Variant, role: string) => runs.filter((r) => r.variant === v && r.role === role && !r.error);
  const sect = (title: string, role: string, cols: [string, keyof Run][]) => {
    const out = [`### ${title}`, "", "| variant · metric (ms from request) | p50 | p90 | mean | n |", "|---|---|---|---|---|"];
    for (const v of VARIANTS) for (const [label, k] of cols) out.push(row(`${v} · ${label}`, by(v, role).map((r) => r[k] as number | null)));
    out.push("", "| variant | cost/call p50 (API prices) | claude -p's own cost p50 | errors | warm agent used |", "|---|---|---|---|---|");
    for (const v of VARIANTS) {
      const all = runs.filter((r) => r.variant === v && r.role === role);
      const ok = by(v, role);
      out.push(`| ${v} | ${usd(pct(ok.map((r) => r.costUsd), 0.5))} | ${v === "api" ? "–" : usd(pct(ok.map((r) => r.cliCostUsd ?? NaN).filter(Number.isFinite), 0.5))} | ${all.length - ok.length} | ${v === "api" ? "–" : `${ok.filter((r) => r.warm).length}/${ok.length}`} |`);
    }
    return out.join("\n");
  };
  const e2eRows = (["api", "cli-warm"] as Variant[]).flatMap((v) => {
    const ok = e2e.filter((r) => r.variant === v && !r.error);
    return [
      row(`${v} · TTFA (ack heard)`, ok.map((r) => r.ttfa)), row(`${v} · router first token`, ok.map((r) => r.llmFirst)),
      row(`${v} · Opus first token`, ok.map((r) => r.opusFirst)), row(`${v} · Opus spoken line`, ok.map((r) => r.opusSpoken)),
      row(`${v} · TTA (answer heard)`, ok.map((r) => r.tta)),
    ];
  });
  const md = [
    "# Claude backends: HTTP API (OpenRouter) vs `claude -p` agents",
    "",
    `Run ${started} · ${N.router} router / ${N.fillers} progress-line / ${N.opus} Opus calls per variant, sequential, ${GAP_MS / 1000} s apart · same prompts for every variant.`,
    "",
    "- **api**: `@anthropic-ai/sdk` → OpenRouter's Anthropic-compatible endpoint (router: forced `route` tool with eager input streaming).",
    "- **cli-warm**: pre-spawned `claude -p --input-format stream-json` agents (one waiting per role, replaced as soon as one is taken).",
    "- **cli-cold**: `claude -p` spawned per call (no pool) — what the warm pool saves.",
    "",
    "Router: Haiku 5.5, effort low, U3 transcript with one pointing word. Opus: Opus 5.5, effort medium, the fixture codebase in the system prompt.",
    "",
    sect("Router (Haiku)", "router", [["first token", "ttft"], ["decision", "decision"], ["ack text complete", "ack"], ["total", "total"]]),
    "",
    sect("Progress lines (Haiku)", "fillers", [["total", "total"]]),
    "",
    sect("Opus", "opus", [["first token", "ttft"], ["SPOKEN line ready", "spoken"], ["total", "total"]]),
    "",
    ...(SKIP_E2E ? [] : [
      "### End-to-end B turns (pipeline, real audio over /ws, forced router, no fillers)", "",
      "| variant · metric (ms from key release) | p50 | p90 | mean | n |", "|---|---|---|---|---|", ...e2eRows, "",
      `Errors: ${e2e.filter((r) => r.error).length}. Played times are approximate (headless client reports the first byte as played).`,
    ]),
    "",
    "Raw runs: `docs/report-data/bench-claude-backends.json`.",
  ].join("\n");
  mkdirSync(new URL("../docs/report-data", import.meta.url), { recursive: true });
  writeFileSync(new URL("../docs/report-data/bench-claude-backends.json", import.meta.url), JSON.stringify({ started, N, runs, e2e }, null, 2));
  writeFileSync(new URL("../docs/BENCH-claude-backends.md", import.meta.url), md + "\n");
  console.log("\n" + md);
  process.exit(0);
}

main().catch((e) => { console.error(e); stopClaudeAgents(); process.exit(1); });
