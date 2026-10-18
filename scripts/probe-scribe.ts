// T1 probe: ElevenLabs Scribe v2 Realtime. Checks (1) commit with empty audio_base_64,
// (2) committed_transcript vs committed_transcript_with_timestamps, (3) whether word
// timestamps reset per commit (two commits, same audio). Run: npx tsx scripts/probe-scribe.ts
// Optional: PROBE_WAV=path/to/speech.wav (PCM16 mono 24 kHz) — a tone yields no words.
import { loadDesktopEnv } from "../electron/settings.ts";
import { existsSync, readFileSync } from "node:fs";
import WebSocket from "ws";

loadDesktopEnv(); // the API keys saved in Settings (a shell variable wins)

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.log("SKIP: ELEVENLABS_API_KEY not set");
  process.exit(0);
}
const RATE = 24000;

function tone(seconds = 1, hz = 440): Buffer {
  const n = Math.round(seconds * RATE);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / RATE) * 8000), i * 2);
  return buf;
}
function loadAudio(): Buffer {
  const path = process.env.PROBE_WAV ?? "fixtures/smoke/hello.wav";
  if (!existsSync(path)) return tone();
  const wav = readFileSync(path);
  const rate = wav.readUInt32LE(24), ch = wav.readUInt16LE(22), at = wav.indexOf("data");
  if (rate !== RATE || ch !== 1 || at < 0) {
    console.log(`(${path} is ${rate} Hz/${ch} ch, need 24 kHz mono — using tone)`);
    return tone();
  }
  console.log(`(using ${path})`);
  return wav.subarray(at + 8, at + 8 + wav.readUInt32LE(at + 4));
}
function sample(v: unknown, max = 600): string {
  const s = JSON.stringify(v, (_k, x) =>
    typeof x === "string" && x.length > 80 ? `<${x.length} chars>` : Array.isArray(x) && x.length > 6 ? [...x.slice(0, 6), `…+${x.length - 6}`] : x,
  );
  return s.length > max ? s.slice(0, max) + "…" : s;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const audio = loadAudio();
const audioSec = audio.length / 2 / RATE;
const qs = new URLSearchParams({
  model_id: "scribe_v2_realtime",
  audio_format: "pcm_24000",
  commit_strategy: "manual",
  include_timestamps: "true",
  language_code: "en",
});
const ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${qs}`, { headers: { "xi-api-key": KEY } });
const seen = new Map<string, number>();
const firstWordStart: number[] = [];
const t0 = Date.now();
let tCommit = 0;

const chunk = (b: Buffer, commit = false) =>
  ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b.toString("base64"), commit, sample_rate: RATE }));

async function streamThenCommit(label: string) {
  for (let i = 0; i < audio.length; i += 4800) {
    chunk(audio.subarray(i, i + 4800)); // 100 ms chunks at real-time pace
    await sleep(100);
  }
  tCommit = Date.now();
  console.log(`-- ${label}: commit with EMPTY audio_base_64`);
  chunk(Buffer.alloc(0), true);
}

ws.on("unexpected-response", (_req, res) => console.log(`HTTP ${res.statusCode} on upgrade`));
ws.on("error", (e) => console.log("socket error:", e.message));
ws.on("close", (code, reason) => {
  console.log(`\nclose ${code} ${reason.toString()}\nevent counts:`, Object.fromEntries(seen));
  const [a, b] = firstWordStart;
  if (a === undefined || b === undefined) console.log("timestamp reset per commit: INCONCLUSIVE (need words in both commits; set PROBE_WAV)");
  else console.log(`first word start: commit1=${a}s commit2=${b}s (audio ${audioSec}s) → ${b >= audioSec - 0.05 ? "CUMULATIVE (session clock)" : "RESETS per commit"}`);
  process.exit(0);
});

ws.on("message", async (raw) => {
  const ev = JSON.parse(raw.toString()) as Record<string, any>;
  const type = String(ev.message_type);
  const n = (seen.get(type) ?? 0) + 1;
  seen.set(type, n);
  const dt = tCommit ? ` (commit+${Date.now() - tCommit}ms)` : "";
  if (n === 1 || type.startsWith("committed")) console.log(`+${Date.now() - t0}ms ${type}${dt}\n  ${sample(ev)}`);
  if (type === "committed_transcript_with_timestamps") {
    const w = (ev.words ?? []).find((x: any) => x.type === "word");
    if (w) firstWordStart.push(w.start);
    if ((seen.get(type) ?? 0) === 1) {
      await sleep(300);
      await streamThenCommit("commit 2 (same session)");
    } else setTimeout(() => ws.close(), 500);
  }
  if (type === "session_started") await streamThenCommit("commit 1");
});

setTimeout(() => {
  console.log("timeout after 30 s");
  ws.close();
}, 30_000);
