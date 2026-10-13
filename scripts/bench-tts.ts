// Benchmark: ElevenLabs (v4 Turbo, Flash v2.5) vs on-device macOS speech (tools/mactts).
// 1) TTS alone: text streamed word by word (like Haiku's ack) → first audio byte, total, audio length.
// 2) Full B turns over /ws with real audio (claude -p agents, forced router, no fillers): TTFA / TTA.
// Writes docs/BENCH-tts.md and docs/report-data/bench-tts.json.
//   npm run bench:tts -- [--n 5] [--e2e 3]
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { openTts as openElevenTts } from "../server/adapters/elevenTts.ts";
import { openMacTts, setMacTtsLogger, startMacTts, stopMacTts } from "../server/adapters/macTts.ts";
import type { TtsModel } from "../shared/config.ts";

const arg = (k: string, d: number) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg("n", 5), E2E = arg("e2e", 3);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const voiceId = process.env.ELEVENLABS_VOICE_ID ?? "";
const MODELS: TtsModel[] = ["eleven_v4_turbo", "eleven_flash_v2_5", "macos"];
const TEXTS = { en: "Let me check the features section styles. One moment.", ro: "Mă uit la stilurile secțiunii. Un moment." };
setMacTtsLogger(() => {});

interface Run { model: TtsModel; lang: string; i: number; firstByte: number | null; total: number; audioS: number; error?: string }
const runs: Run[] = [];

async function one(model: TtsModel, lang: "en" | "ro", i: number): Promise<void> {
  const open = model === "macos" ? openMacTts : openElevenTts;
  const t0 = performance.now();
  let first: number | null = null, bytes = 0;
  try {
    const tts = await open({ mark: () => {}, voiceId, model, segment: "ack", language: lang });
    tts.onAudio((b) => { first ??= performance.now() - t0; bytes += b.length; });
    for (const w of TEXTS[lang].split(/(?<= )/)) { tts.pushText(w); await sleep(30); } // ~Haiku's streaming pace
    tts.flush();
    await tts.done();
    tts.close();
    runs.push({ model, lang, i, firstByte: first, total: performance.now() - t0, audioS: bytes / 48000 });
  } catch (e) {
    runs.push({ model, lang, i, firstByte: first, total: performance.now() - t0, audioS: bytes / 48000, error: String(e) });
  }
}

interface E2E { model: TtsModel; i: number; ttfa: number | null; tta: number | null; ackTts: number | null; error?: string }
const e2e: E2E[] = [];

async function turn(model: TtsModel, i: number): Promise<void> {
  const { default: WebSocket } = await import("ws");
  const { startServer } = await import("../server/index.ts");
  const { parseWav } = await import("../server/wav.ts");
  const { DEFAULT_CONFIG } = await import("../shared/config.ts");
  const server = await startServer(0, { quiet: true, persist: false });
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "clock.sync", rttMs: 0, offsetMs: performance.timeOrigin }));
  const turnId = `t-${model}-${i}`;
  const done = new Promise<any>((res) => ws.on("message", (d, bin) => {
    if (bin) return;
    const m = JSON.parse(d.toString());
    if (m.turnId !== turnId) return;
    if (m.type === "audio.segment" && m.state === "start") ws.send(JSON.stringify({ type: "audio.played", turnId, segment: m.segment, tPlayed: performance.now() }));
    if (m.type === "turn.done") res(m.run);
  }));
  const wav = parseWav(readFileSync(new URL("../fixtures/smoke/bench-question.wav", import.meta.url)));
  const t0 = performance.now();
  ws.send(JSON.stringify({ type: "turn.start", turnId, config: { ...DEFAULT_CONFIG, approach: "pipeline", routerMode: "forced", ttsModel: model, fillers: false }, tPress: t0 }));
  ws.send(JSON.stringify({ type: "turn.audioStart", turnId, tAudioStart: t0 }));
  for (let off = 0, j = 0; off < wav.data.length; off += 960, j++) {
    ws.send(wav.data.subarray(off, off + 960));
    const w = t0 + (j + 1) * 20 - performance.now(); if (w > 0) await sleep(w);
  }
  ws.send(JSON.stringify({ type: "turn.release", turnId, tRelease: performance.now() }));
  const run = await done;
  const ackTts = run.marks["ack.ttsFirstByte"] !== undefined && run.marks["llm.firstToken"] !== undefined ? run.marks["ack.ttsFirstByte"] - run.marks["llm.firstToken"] : null;
  e2e.push({ model, i, ttfa: run.metrics.ttfa, tta: run.metrics.tta, ackTts, error: run.error });
  ws.close();
  await server.close();
}

const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const k = (s.length - 1) * p, f = Math.floor(k), c = Math.ceil(k); return s[f]! + (s[c]! - s[f]!) * (k - f); };
const ms = (x: number) => (Number.isFinite(x) ? `${Math.round(x)}` : "–");
const row = (label: string, xs: (number | null)[]) => { const v = xs.filter((x): x is number => typeof x === "number"); return `| ${label} | ${ms(pct(v, 0.5))} | ${ms(pct(v, 0.9))} | ${v.length} |`; };

async function main(): Promise<void> {
  const started = new Date().toISOString();
  await startMacTts();
  for (const model of MODELS) {
    if (model !== "macos" && !voiceId) { console.log(`SKIP ${model}: ELEVENLABS_VOICE_ID not set`); continue; }
    for (const lang of ["en", "ro"] as const) for (let i = 0; i < N; i++) {
      await one(model, lang, i);
      const r = runs.at(-1)!;
      console.log(`  ${model} ${lang} ${i}: first byte ${ms(r.firstByte ?? NaN)} ms · total ${ms(r.total)} ms · ${r.audioS.toFixed(1)} s audio${r.error ? ` ERROR ${r.error}` : ""}`);
      await sleep(500);
    }
  }
  if (E2E > 0) {
    const { startClaudeAgents, stopClaudeAgents, setCliLogger } = await import("../server/adapters/claudeCli.ts");
    const { setLogger } = await import("../server/adapters/claude.ts");
    setLogger(() => {}); setCliLogger(() => {});
    startClaudeAgents();
    await sleep(3000);
    for (const model of ["eleven_v4_turbo", "macos"] as TtsModel[]) for (let i = 0; i < E2E; i++) {
      try { await turn(model, i); } catch (e) { e2e.push({ model, i, ttfa: null, tta: null, ackTts: null, error: String(e) }); }
      const r = e2e.at(-1)!;
      console.log(`  e2e ${model} ${i}: ttfa ${ms(r.ttfa ?? NaN)} · tta ${ms(r.tta ?? NaN)}${r.error ? ` ERROR ${r.error}` : ""}`);
      await sleep(2500);
    }
    stopClaudeAgents();
  }
  stopMacTts();

  const ok = (m: TtsModel, lang?: string) => runs.filter((r) => r.model === m && (!lang || r.lang === lang) && !r.error);
  const md = [
    "# TTS: ElevenLabs vs on-device macOS speech",
    "",
    `Run ${started} · ${N} runs per model and language · text streamed word by word, 30 ms apart (like the router's ack) · then flush.`,
    "",
    "- **eleven_v4_turbo**: Text-to-Dialogue WebSocket (one socket per segment, opened inside the measurement).",
    "- **eleven_flash_v2_5**: TTS stream-input WebSocket.",
    "- **macos**: `tools/mactts` (AVSpeechSynthesizer, persistent helper, voices warmed): text goes a sentence at a time. Voices: best en-US voice installed, Ioana for Romanian.",
    "",
    "### TTS alone (ms from the first text pushed)",
    "",
    "| model · metric | p50 | p90 | n |",
    "|---|---|---|---|",
    ...MODELS.flatMap((m) => (["en", "ro"] as const).flatMap((l) => [row(`${m} · ${l} · first audio`, ok(m, l).map((r) => r.firstByte)), row(`${m} · ${l} · done`, ok(m, l).map((r) => r.total))])),
    "",
    `Errors: ${runs.filter((r) => r.error).length}.`,
    "",
    ...(e2e.length ? [
      "### Full B turns (real audio, claude -p agents, forced router, no fillers; ms from key release)",
      "",
      "| model · metric | p50 | p90 | n |",
      "|---|---|---|---|",
      ...(["eleven_v4_turbo", "macos"] as TtsModel[]).flatMap((m) => {
        const v = e2e.filter((r) => r.model === m && !r.error);
        return [row(`${m} · TTFA (ack heard)`, v.map((r) => r.ttfa)), row(`${m} · router first token → ack audio`, v.map((r) => r.ackTts)), row(`${m} · TTA (answer heard)`, v.map((r) => r.tta))];
      }),
      "",
      `Errors: ${e2e.filter((r) => r.error).length}. Played times are approximate (headless client reports the first byte as played).`,
    ] : []),
    "",
    "Raw runs: `docs/report-data/bench-tts.json`.",
  ].join("\n");
  mkdirSync(new URL("../docs/report-data", import.meta.url), { recursive: true });
  writeFileSync(new URL("../docs/report-data/bench-tts.json", import.meta.url), JSON.stringify({ started, N, runs, e2e }, null, 2));
  const reportUrl = new URL("../docs/BENCH-tts.md", import.meta.url);
  let findings = "";
  try { const prev = readFileSync(reportUrl, "utf8"); const k = prev.indexOf("\n## Findings"); if (k >= 0) findings = prev.slice(k); } catch { /* first run */ }
  writeFileSync(reportUrl, md + "\n" + findings);
  console.log("\n" + md);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
