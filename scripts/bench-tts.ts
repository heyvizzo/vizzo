// Benchmark: ElevenLabs (v4 Turbo, Flash v2.5) vs on-device macOS speech (tools/mactts).
// 1) TTS alone: text streamed word by word (like the router's ack) → first audio byte, total, audio length.
// 2) Full B turns over /ws with real audio (claude -p agents, forced router, no fillers): TTFA / TTA.
// Writes docs/BENCH-tts.md and docs/report-data/bench-tts.json.
//   npm run bench:tts -- [--n 5] [--e2e 3]
import { loadDesktopEnv } from "../electron/settings.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { openTts as openElevenTts } from "../server/adapters/elevenTts.ts";
import { openLocalTts, setLocalTtsLogger, startLocalTts, stopLocalTts } from "../server/adapters/localTts.ts";
import { openOpenAiTts } from "../server/adapters/openaiTts.ts";
import { openFishTts } from "../server/adapters/fishTts.ts";
import { isLocalTts, type TtsModel } from "../shared/config.ts";

loadDesktopEnv(); // the API keys saved in Settings (a shell variable wins)

const arg = (k: string, d: number) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg("n", 5), E2E = arg("e2e", 3);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const voiceId = process.env.ELEVENLABS_VOICE_ID ?? "";
const MODELS: TtsModel[] = ["eleven_v4_turbo", "eleven_flash_v2_5", "openai_tts_1", "fish_drama_3", "macos", "kokoro", "piper"];
const E2E_MODELS: TtsModel[] = ["eleven_v4_turbo", "macos", "kokoro", "piper"];
const TEXTS = { en: "Let me check the features section styles. One moment.", ro: "Mă uit la stilurile secțiunii. Un moment." };
setLocalTtsLogger(() => {});

interface Run { model: TtsModel; lang: string; i: number; firstByte: number | null; total: number; audioS: number; error?: string }
const runs: Run[] = [];

async function one(model: TtsModel, lang: "en" | "ro", i: number): Promise<void> {
  const open = isLocalTts(model) ? openLocalTts(model) : model === "openai_tts_1" ? openOpenAiTts : model === "fish_drama_3" ? openFishTts : openElevenTts;
  const t0 = performance.now();
  let first: number | null = null, bytes = 0;
  try {
    const tts = await open({ mark: () => {}, voiceId, model, segment: "ack", language: lang });
    tts.onAudio((b) => { first ??= performance.now() - t0; bytes += b.length; });
    for (const w of TEXTS[lang].split(/(?<= )/)) { tts.pushText(w); await sleep(30); } // ~the router's streaming pace
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

/**
 * One B turn up to the ack: speech is what the ack's timing depends on (the answer waits on the solver).
 * Measures key release → first ack audio (client clock) and the router's first token → ack audio
 * (server marks), then cancels the turn.
 */
async function turn(model: TtsModel, i: number): Promise<void> {
  const { default: WebSocket } = await import("ws");
  const { startServer } = await import("../server/index.ts");
  const { parseWav } = await import("../server/wav.ts");
  const { DEFAULT_CONFIG } = await import("../shared/config.ts");
  const server = await startServer(0, { quiet: true, persist: false });
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
  await new Promise((r) => ws.once("open", r));
  const turnId = `t-${model}-${i}`;
  let tRelease = 0;
  const marks: Record<string, number> = {};
  const acked = new Promise<{ ttfa: number }>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("no ack audio within 30 s")), 30_000);
    ws.on("message", (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      if (m.turnId !== turnId) return;
      if (m.type === "mark") marks[m.name] ??= m.serverNow;
      if (m.type === "error") { clearTimeout(timer); rej(new Error(`${m.source}: ${m.message}`)); }
      if (m.type === "audio.segment" && m.state === "start" && (m.segment === "ack" || m.segment === "answer")) {
        clearTimeout(timer);
        res({ ttfa: performance.now() - tRelease });
      }
    });
  });
  acked.catch(() => {});
  const wav = parseWav(readFileSync(new URL("../fixtures/smoke/bench-question.wav", import.meta.url)));
  const t0 = performance.now();
  ws.send(JSON.stringify({ type: "turn.start", turnId, config: { ...DEFAULT_CONFIG, approach: "pipeline", routerMode: "forced", ttsModel: model, fillers: false }, tPress: t0 }));
  ws.send(JSON.stringify({ type: "turn.audioStart", turnId, tAudioStart: t0 }));
  for (let off = 0, j = 0; off < wav.data.length; off += 960, j++) {
    ws.send(wav.data.subarray(off, off + 960));
    const w = t0 + (j + 1) * 20 - performance.now(); if (w > 0) await sleep(w);
  }
  tRelease = performance.now();
  ws.send(JSON.stringify({ type: "turn.release", turnId, tRelease }));
  try {
    const { ttfa } = await acked;
    await sleep(300); // let the ack's ttsFirstByte mark arrive
    const ackTts = marks["ack.ttsFirstByte"] !== undefined && marks["llm.firstToken"] !== undefined ? marks["ack.ttsFirstByte"] - marks["llm.firstToken"] : null;
    e2e.push({ model, i, ttfa, tta: null, ackTts });
  } catch (e) {
    e2e.push({ model, i, ttfa: null, tta: null, ackTts: null, error: String(e) });
  }
  ws.send(JSON.stringify({ type: "turn.cancel", turnId }));
  ws.close();
  await server.close();
}

const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const k = (s.length - 1) * p, f = Math.floor(k), c = Math.ceil(k); return s[f]! + (s[c]! - s[f]!) * (k - f); };
const ms = (x: number) => (Number.isFinite(x) ? `${Math.round(x)}` : "–");
const row = (label: string, xs: (number | null)[]) => { const v = xs.filter((x): x is number => typeof x === "number"); return `| ${label} | ${ms(pct(v, 0.5))} | ${ms(pct(v, 0.9))} | ${v.length} |`; };

async function main(): Promise<void> {
  const started = new Date().toISOString();
  await Promise.all((["macos", "kokoro", "piper"] as const).map((e) => startLocalTts(e)));
  for (const model of MODELS) {
    if (model.startsWith("eleven_") && !voiceId) { console.log(`SKIP ${model}: ELEVENLABS_VOICE_ID not set`); continue; }
    if (model === "openai_tts_1" && !process.env.OPENAI_API_KEY) { console.log(`SKIP ${model}: OPENAI_API_KEY not set`); continue; }
    if (model === "fish_drama_3" && !process.env.OPENROUTER_API_KEY) { console.log(`SKIP ${model}: OPENROUTER_API_KEY not set`); continue; }
    for (const lang of ["en", "ro"] as const) for (let i = 0; i < N; i++) {
      await one(model, lang, i);
      const r = runs.at(-1)!;
      console.log(`  ${model} ${lang} ${i}: first byte ${ms(r.firstByte ?? NaN)} ms · total ${ms(r.total)} ms · ${r.audioS.toFixed(1)} s audio${r.error ? ` ERROR ${r.error}` : ""}`);
      await sleep(500);
    }
  }
  if (E2E > 0) {
    const { configureWarm, setWarmLogger, stopWarm } = await import("../server/adapters/warmPool.ts");
    const { setLogger } = await import("../server/adapters/claude.ts");
    const { currentSelection } = await import("../server/llmSelection.ts");
    setLogger(() => {}); setWarmLogger(() => {});
    configureWarm(currentSelection());
    await sleep(3000);
    for (const model of E2E_MODELS) for (let i = 0; i < E2E; i++) {
      try { await turn(model, i); } catch (e) { e2e.push({ model, i, ttfa: null, tta: null, ackTts: null, error: String(e) }); }
      const r = e2e.at(-1)!;
      console.log(`  e2e ${model} ${i}: ttfa ${ms(r.ttfa ?? NaN)} · tta ${ms(r.tta ?? NaN)}${r.error ? ` ERROR ${r.error}` : ""}`);
      await sleep(2500);
    }
    stopWarm();
  }
  stopLocalTts();

  const ok = (m: TtsModel, lang?: string) => runs.filter((r) => r.model === m && (!lang || r.lang === lang) && !r.error);
  const md = [
    "# TTS: ElevenLabs vs on-device macOS speech",
    "",
    `Run ${started} · ${N} runs per model and language · text streamed word by word, 30 ms apart (like the router's ack) · then flush.`,
    "",
    "- **eleven_v4_turbo**: Text-to-Dialogue WebSocket (one socket per segment, opened inside the measurement).",
    "- **eleven_flash_v2_5**: TTS stream-input WebSocket.",
    "- **openai_tts_1**: OpenAI `tts-1` over HTTP (`/v1/audio/speech`, `response_format: pcm`, voice `coral`), one request per sentence, the next requested while the current one streams.",
    "- **kokoro**: Kokoro-82M ONNX on CPU (`tools/localtts`, voice af_heart; Romanian via espeak phonemes + the Italian voice if_sara), long sentences split at clauses.",
    "- **piper**: Piper (`tools/localtts`, en_US-lessac-medium / ro_RO-mihai-medium, 22.05 kHz resampled to 24 kHz).",
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
      "### B turns up to the ack (real audio, claude -p agents, forced router, no fillers; ms from key release; the turn is cancelled after the ack, since the answer's timing is the solver's)",
      "",
      "| model · metric | p50 | p90 | n |",
      "|---|---|---|---|",
      ...E2E_MODELS.flatMap((m) => {
        const v = e2e.filter((r) => r.model === m && !r.error);
        return [row(`${m} · TTFA (ack audio arrives)`, v.map((r) => r.ttfa)), row(`${m} · router first token → ack audio`, v.map((r) => r.ackTts))];
      }),
      "",
      `Errors: ${e2e.filter((r) => r.error).length}. TTFA here = when the first ack audio reaches the client (no playback buffering).`,
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
