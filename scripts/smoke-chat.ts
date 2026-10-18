// Headless multi-turn chat over the real /ws with real vendors (RunConfig.memory = true): checks that the
// conversation carries over. Usage:
//   npm run smoke:chat -- a.wav b.wav c.wav
// Audio is reported "played" on the first received byte of each segment (headless approximation).
import { loadDesktopEnv } from "../electron/settings.ts";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { DEFAULT_CONFIG } from "../shared/config.ts";
import type { ServerMsg } from "../shared/protocol.ts";
import { startServer } from "../server/index.ts";
import { parseWav } from "../server/wav.ts";

loadDesktopEnv(); // the API keys saved in Settings (a shell variable wins)

const files = process.argv.slice(2).filter((a) => a.endsWith(".wav"));
if (!files.length) { console.error("usage: npm run smoke:chat -- turn1.wav turn2.wav …"); process.exit(1); }
if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_VOICE_ID) {
  console.log("SKIP smoke:chat: needs ELEVENLABS (+VOICE_ID) and OPENROUTER/ANTHROPIC keys");
  process.exit(0);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = await startServer(0, { quiet: true, persist: false });
const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
await new Promise((r) => ws.once("open", r));
const listeners = new Set<(m: ServerMsg) => void>();
ws.on("message", (d, bin) => { if (!bin) for (const l of listeners) l(JSON.parse(d.toString())); });
// Background jobs and notices arrive outside turns.
const jobs = new Map<string, string>();
let noticeBytes = 0, inNotice = false, noticesDone = 0;
ws.on("message", (d, bin) => { if (bin && inNotice) noticeBytes += (d as Buffer).length; });
listeners.add((m) => {
  if (m.type === "job") {
    jobs.set(m.job.jobId, m.job.state);
    if (m.job.state === "running") console.log(`  [job] started: "${m.job.question.slice(0, 90)}…" (est ${m.job.estimateS} s)`);
    else console.log(`  [job] ${m.job.state} after ${((m.job.elapsedMs ?? 0) / 1000).toFixed(1)} s: ${m.job.spoken ?? m.job.error}`);
  }
  if (m.type === "notice") {
    inNotice = m.state === "start";
    if (m.state === "end") { noticesDone++; console.log(`  [notice] spoken (${(noticeBytes / 48000).toFixed(1)} s of audio)`); }
    if (m.state === "start") noticeBytes = 0;
  }
});

for (const [i, file] of files.entries()) {
  const wav = parseWav(readFileSync(file));
  const turnId = `chat-${i}`;
  let voice = "", transcript = "", decision = "";
  const segs: string[] = [];
  const played = new Set<string>();
  const done = new Promise<Extract<ServerMsg, { type: "turn.done" }>>((resolve) => {
    const l = (m: ServerMsg) => {
      if (!("turnId" in m) || m.turnId !== turnId) return;
      if (m.type === "voice.text") voice += m.delta;
      if (m.type === "stt.final") transcript = m.text;
      if (m.type === "decision") decision = `${m.intent}${m.estimateS !== null ? ` ~${m.estimateS} s` : ""}${m.background ? " → background" : ""}`;
      if (m.type === "audio.segment" && m.state === "start") segs.push(m.segment);
      if (m.type === "audio.segment" && m.state === "start" && !played.has(m.segment)) {
        played.add(m.segment);
        ws.send(JSON.stringify({ type: "audio.played", turnId, segment: m.segment, tPlayed: performance.now() }));
      }
      if (m.type === "error") console.log(`  error [${m.source}] ${m.message}`);
      if (m.type === "turn.done") { listeners.delete(l); resolve(m); }
    };
    listeners.add(l);
  });
  const t0 = performance.now();
  ws.send(JSON.stringify({ type: "turn.start", turnId, config: { ...DEFAULT_CONFIG, approach: "pipeline", memory: true, routerMode: "auto", fillers: true, backgroundLongTasks: true }, tPress: t0 }));
  ws.send(JSON.stringify({ type: "turn.audioStart", turnId, tAudioStart: t0 }));
  const frame = 960;
  for (let off = 0, k = 0; off < wav.data.length; off += frame, k++) {
    ws.send(wav.data.subarray(off, off + frame));
    const wait = t0 + (k + 1) * 20 - performance.now();
    if (wait > 0) await sleep(wait);
  }
  ws.send(JSON.stringify({ type: "turn.release", turnId, tRelease: performance.now() }));
  const { run } = await done;
  console.log(`\n── turn ${i + 1}`);
  console.log(`  you:  ${transcript || run.transcript || "(no transcript)"}`);
  console.log(`  decision: ${decision || "(none)"} · segments: ${segs.join(" → ") || "(none)"}`);
  console.log(`  bot:  ${voice.trim()}`);
  console.log(`  ttfa ${Math.round(run.metrics.ttfa ?? NaN)} ms · tta ${Math.round(run.metrics.tta ?? NaN)} ms · $${run.costUsd.toFixed(4)}` +
    (run.markMeta?.["llm.request"]?.historyRecapTurns !== undefined ? ` · recap of ${run.markMeta["llm.request"].historyRecapTurns} turn(s)` : "") +
    (run.error ? ` · ERROR ${run.error}` : ""));
}
// Wait for background jobs to finish and be announced.
const t0 = Date.now();
const doneJobs = () => [...jobs.values()].filter((s) => s === "done").length;
while ([...jobs.values()].some((s) => s === "running") || inNotice || noticesDone < doneJobs()) {
  if (Date.now() - t0 > 240_000) { console.log("  (gave up waiting for jobs)"); break; }
  await sleep(500);
}
await sleep(2000);
ws.close();
await server.close();
