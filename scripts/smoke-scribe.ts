// T3 smoke: stream fixtures/smoke/hello.wav to Scribe v2 Realtime at real-time pace in 20 ms
// chunks, commit, and print words + release→final latency + every mark.
// Run: npm run smoke:scribe   (optional SMOKE_WAV=path/to/24k-mono-pcm16.wav)
import { loadDesktopEnv } from "../electron/settings.ts";
import { readFileSync } from "node:fs";
import type { MarkName } from "../shared/marks.ts";
import { openScribe } from "../server/adapters/scribe.ts";
import { serverNow } from "../server/clock.ts";
import { parseWav } from "../server/wav.ts";

loadDesktopEnv(); // the API keys saved in Settings (a shell variable wins)

if (!process.env.ELEVENLABS_API_KEY) {
  console.log("SKIP: ELEVENLABS_API_KEY not set");
  process.exit(0);
}

const path = process.env.SMOKE_WAV ?? "fixtures/smoke/hello.wav";
const wav = parseWav(readFileSync(path));
if (wav.sampleRate !== 24000 || wav.channels !== 1) {
  console.error(`FAIL: ${path} is ${wav.sampleRate} Hz / ${wav.channels} ch; need 24 kHz mono PCM16`);
  process.exit(1);
}
const FRAME = 24000 * 2 * 0.02; // 20 ms
console.log(`streaming ${path}: ${(wav.data.length / 48000).toFixed(2)} s`);

const marks: { name: MarkName | "open" | "release"; t: number; meta?: Record<string, unknown> }[] = [];
const t0 = serverNow();
const sleepUntil = (t: number) => new Promise((r) => setTimeout(r, Math.max(0, t - serverNow())));

const stt = await openScribe({
  mark: (name, meta) => marks.push({ name, t: serverNow(), meta }),
  keyterms: process.env.SMOKE_KEYTERMS?.split(","),
});
marks.push({ name: "open", t: serverNow() });
stt.onPartial((text) => text && console.log(`  partial +${Math.round(serverNow() - t0)}ms: ${text}`));

const tStart = serverNow();
for (let i = 0, k = 0; i < wav.data.length; i += FRAME, k++) {
  await sleepUntil(tStart + k * 20);
  stt.pushAudio(wav.data.subarray(i, i + FRAME));
}
await sleepUntil(tStart + Math.ceil(wav.data.length / FRAME) * 20);
const tRelease = serverNow();
marks.push({ name: "release", t: tRelease });
stt.commit();

let code = 0;
try {
  const r = await stt.final();
  const tFinal = serverNow();
  console.log(`\ntranscript: ${JSON.stringify(r.text)}`);
  console.log("words:");
  for (const w of r.words) console.log(`  ${w.start.toFixed(3)}–${w.end.toFixed(3)} s  ${w.text}`);
  console.log(`\nrelease → final: ${Math.round(tFinal - tRelease)} ms`);
  console.log(`audio seconds sent: ${stt.seconds.toFixed(3)}`);
  if (!r.text) code = 1;
} catch (e) {
  console.error(`FAIL: ${(e as Error).message}`);
  code = 1;
} finally {
  stt.close();
}

console.log("\nmarks (ms from start; Δ from release):");
for (const m of marks) {
  const meta = m.meta ? ` ${JSON.stringify(m.meta)}` : "";
  console.log(`  ${m.name.padEnd(18)} +${String(Math.round(m.t - t0)).padStart(6)}  Δ${String(Math.round(m.t - tRelease)).padStart(6)}${meta}`);
}
process.exit(code);
