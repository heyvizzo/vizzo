// T7 end-to-end smoke: starts the server in-process on a random port, connects to the real /ws as a
// headless client, syncs clocks, replays fixtures/smoke/hello.wav at real-time pace (20 ms frames)
// through the pipeline, and prints a RunRecord summary (marks in ms relative to release).
//
//   npm run smoke:e2e                 real adapters; SKIPs if keys are missing
//   npm run smoke:e2e -- --fake       fake adapters (no keys), whole server + WS path exercised
//
// Headless approximation: there is no audio output, so `audio.played` is reported the moment the
// first binary frame of a segment arrives (no player buffering / output latency). Real TTFA/TTA come
// from the browser lab.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { startServer } from "../server/index.ts";
import { createFakeDeps, REALISTIC_TIMING } from "../server/orchestrators/fakes.ts";
import { createPipelineOrchestrator } from "../server/orchestrators/pipeline.ts";
import { parseWav } from "../server/wav.ts";
import { bestOffset, type PingSample } from "../shared/clock.ts";
import { DEFAULT_CONFIG, type Approach, type RunConfig } from "../shared/config.ts";
import { MARK_NAMES, type MarkName } from "../shared/marks.ts";
import type { ClientMsg, CursorSample, RunRecord, Segment, ServerMsg } from "../shared/protocol.ts";

const args = process.argv.slice(2);
const FAKE = args.includes("--fake");
// "A|B" means either key will do.
const env = (k: string) => k.split("|").some((name) => !!process.env[name]);

type Main = Exclude<Approach, "cursor-only">;
const REQUIRED_KEYS: Record<Main, string[]> = {
  pipeline: ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "OPENROUTER_API_KEY|ANTHROPIC_API_KEY"],
};

const wav = parseWav(readFileSync(new URL("../fixtures/smoke/hello.wav", import.meta.url)));
if (wav.sampleRate !== 24000 || wav.channels !== 1) {
  console.error(`FAIL: hello.wav must be 24 kHz mono PCM16 (got ${wav.sampleRate} Hz, ${wav.channels} ch)`);
  process.exit(1);
}

const approaches: Main[] = ["pipeline"];
const runnable = approaches.filter((a) => {
  if (FAKE) return true;
  const missing = REQUIRED_KEYS[a].filter((k) => !env(k));
  if (missing.length) console.log(`SKIP ${a}: missing ${missing.join(", ")}`);
  return missing.length === 0;
});
if (!runnable.length) {
  console.log("SKIP: no approach has its keys (run with --fake to exercise the server path with fake adapters)");
  process.exit(0);
}

const fakeOrchestrators = FAKE
  ? {
      pipeline: createPipelineOrchestrator(createFakeDeps(REALISTIC_TIMING)),
    }
  : undefined;

const server = await startServer(0, { orchestrators: fakeOrchestrators, persist: !FAKE, quiet: true });
console.log(`server on :${server.port} (${FAKE ? "FAKE adapters" : "real adapters"}); headless client reports audio.played on first received byte per segment`);

// ── headless client ────────────────────────────────────────────────────────

const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
const now = () => performance.now();
const send = (m: ClientMsg) => ws.send(JSON.stringify(m));
const listeners = new Set<(m: ServerMsg | { type: "binary"; data: Buffer }) => void>();
ws.on("message", (data, isBinary) => {
  const m = isBinary ? { type: "binary" as const, data: data as Buffer } : (JSON.parse(data.toString()) as ServerMsg);
  for (const l of listeners) l(m);
});

// Clock sync: 10 pings, keep the lowest RTT (ARCHITECTURE §5).
const samples: PingSample[] = [];
for (let id = 0; id < 10; id++) {
  const clientSent = now();
  const pong = await new Promise<Extract<ServerMsg, { type: "pong" }>>((res) => {
    const l = (m: ServerMsg | { type: "binary" }) => { if (m.type === "pong" && m.id === id) { listeners.delete(l); res(m); } };
    listeners.add(l);
    send({ type: "ping", id, clientNow: clientSent });
  });
  samples.push({ clientSent, clientRecv: now(), serverNow: pong.serverNow });
}
const sync = bestOffset(samples)!;
send({ type: "clock.sync", rttMs: sync.rttMs, offsetMs: sync.offsetMs });
console.log(`clock: rtt ${sync.rttMs.toFixed(2)} ms, offset ${sync.offsetMs.toFixed(1)} ms`);

const FRAME_BYTES = 960; // 20 ms
const sleepUntil = (t: number) => new Promise((r) => setTimeout(r, Math.max(0, t - now())));

function cursorAt(t: number): CursorSample {
  return { t, x: 400, y: 300, scrollX: 0, scrollY: 0, elementPath: "main > section.features", dataSource: "web/cursor/demo/demo.html:34", label: "Features" };
}

async function runTurn(approach: Main): Promise<{ run: RunRecord | null; errors: string[] }> {
  const turnId = `smoke-${approach}-${Date.now()}`;
  const config: RunConfig = { ...DEFAULT_CONFIG, approach };
  const errors: string[] = [];
  let currentSeg: Segment | null = null;
  let awaitingFirst = false;
  const done = new Promise<RunRecord | null>((resolve) => {
    const timer = setTimeout(() => { errors.push("client timeout (90 s)"); listeners.delete(l); resolve(null); }, 90_000);
    const l = (m: ServerMsg | { type: "binary"; data: Buffer }) => {
      if (m.type === "binary") {
        if (awaitingFirst && currentSeg) {
          awaitingFirst = false;
          send({ type: "audio.played", turnId, segment: currentSeg, tPlayed: now() });
        }
        return;
      }
      if ("turnId" in m && m.turnId && m.turnId !== turnId) return;
      if (m.type === "audio.segment" && m.state === "start") { currentSeg = m.segment; awaitingFirst = true; }
      if (m.type === "error") errors.push(`${m.source}: ${m.message}`);
      if (m.type === "turn.done") { clearTimeout(timer); listeners.delete(l); resolve(m.run); }
    };
    listeners.add(l);
  });

  const tPress = now();
  send({ type: "turn.start", turnId, config, tPress, fixtureId: "smoke/hello" });
  await sleepUntil(tPress + 150); // key down → first captured sample
  const tStart = now();
  send({ type: "turn.audioStart", turnId, tAudioStart: tStart });
  let cursorBatch: CursorSample[] = [];
  for (let i = 0, k = 0; i < wav.data.length; i += FRAME_BYTES, k++) {
    await sleepUntil(tStart + k * 20);
    ws.send(wav.data.subarray(i, i + FRAME_BYTES), { binary: true });
    cursorBatch.push(cursorAt(now()));
    if (cursorBatch.length >= 5) { send({ type: "cursor.samples", turnId, samples: cursorBatch }); cursorBatch = []; }
  }
  if (cursorBatch.length) send({ type: "cursor.samples", turnId, samples: cursorBatch });
  await sleepUntil(tStart + (wav.data.length / FRAME_BYTES) * 20);
  send({ type: "turn.release", turnId, tRelease: now() });
  return { run: await done, errors };
}

// ── report ─────────────────────────────────────────────────────────────────

const DELEGATION: MarkName[] = ["llm.toolCall", "ack.ttsFirstByte", "ack.played", "solver.request", "solver.firstToken", "solver.spokenReady", "solver.done"];
const STT: MarkName[] = ["stt.final", "pointing.resolved"];
function applicable(approach: Main, run: RunRecord): MarkName[] {
  const base: MarkName[] = ["press", "release", "llm.request", "llm.firstToken", "answer.ttsFirstByte", "answer.played", "turn.end"];
  const delegated = FAKE || approach === "pipeline" && run.config.routerMode === "forced" || run.marks["solver.request"] !== undefined;
  // Scribe sends no partials for the first ~2 s of audio (API-NOTES), so firstPartial is only required with fakes.
  const stt: MarkName[] = FAKE ? ["stt.firstPartial", ...STT] : STT;
  return [...base, ...stt, ...(delegated ? DELEGATION : [])];
}

const clip = (s: string, n = 140) => (s.length > n ? s.slice(0, n) + "…" : s).replace(/\n/g, " ⏎ ");
let failed = false;

for (const approach of runnable) {
  console.log(`\n═══ ${approach} ═══`);
  const { run, errors } = await runTurn(approach);
  for (const e of errors) console.log(`  error: ${e}`);
  if (!run) { failed = true; continue; }
  const r0 = run.marks.release!;
  console.log(`  runId ${run.runId}  cost $${run.costUsd.toFixed(5)}${run.error ? `  ERROR: ${run.error}` : ""}`);
  console.log(`  transcript: ${clip(run.transcript) || "(none)"}`);
  console.log(`  pointing:   ${run.pointing.length} target(s)`);
  console.log(`  voice:      ${clip(run.voiceText)}`);
  console.log(`  solver:       ${clip(run.solverText) || "(none)"}`);
  console.log(`  marks (ms rel. release):`);
  const present = MARK_NAMES.filter((n) => run.marks[n] !== undefined).sort((a, b) => run.marks[a]! - run.marks[b]!);
  for (const n of present) {
    const meta = run.markMeta?.[n];
    console.log(`    ${n.padEnd(20)} ${(run.marks[n]! - r0).toFixed(0).padStart(7)}${meta ? "  " + JSON.stringify(meta) : ""}`);
  }
  const m = run.metrics;
  console.log(`  metrics: ${Object.entries(m).map(([k, v]) => `${k}=${v === null ? "–" : Math.round(v)}`).join(" ")}`);
  const missing = applicable(approach, run).filter((n) => run.marks[n] === undefined);
  console.log(missing.length ? `  MISSING marks: ${missing.join(", ")}` : `  all applicable marks present ✓`);
  if (missing.length || run.error) failed = true;
}

ws.close();
await server.close();
console.log(failed ? "\nFAIL" : "\nOK");
process.exit(failed ? 1 : 0);
