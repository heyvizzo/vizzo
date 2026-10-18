// T5 smoke: stream a sentence word by word (~30 ms apart) into each TTS model, flush, save
// out/tts-<model>.wav (24 kHz PCM16 mono), print text-in → first-byte latency and marks.
// Run: npm run smoke:tts   (TTS_TRANSPORT=http for the HTTP fallback, TTS_DEBUG=1 for chunk logs)
import { loadDesktopEnv } from "../electron/settings.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { serverNow } from "../server/clock.ts";
import { openTts } from "../server/adapters/elevenTts.ts";
import type { TtsModel } from "../shared/config.ts";
import { SAMPLE_RATE } from "../shared/config.ts";
import { writeWavPcm16 } from "../server/wav.ts";

loadDesktopEnv(); // the API keys saved in Settings (a shell variable wins)

const KEY = process.env.ELEVENLABS_API_KEY;
const VOICE = process.env.ELEVENLABS_VOICE_ID;
if (!KEY || !VOICE) {
  console.log("SKIP smoke:tts: ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID must be set in Settings");
  process.exit(0);
}

const SENTENCE = "Sure, one sec. The header is sticky so the navigation stays visible while you scroll.";
const MODELS: TtsModel[] = ["eleven_v4_turbo", "eleven_flash_v2_5"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


mkdirSync("out", { recursive: true });
let failed = false;
for (const model of MODELS) {
  console.log(`\n=== ${model} (${process.env.TTS_TRANSPORT === "http" ? "http" : "ws"})`);
  const marks: { name: string; t: number; meta?: Record<string, unknown> }[] = [];
  const tOpen = serverNow();
  try {
    const tts = await openTts({ voiceId: VOICE, model, segment: "answer", mark: (name, meta) => marks.push({ name, t: serverNow(), meta }) });
    const tReady = serverNow();
    const chunks: Buffer[] = [];
    let firstChunkLen = 0;
    tts.onAudio((b) => {
      if (!firstChunkLen) firstChunkLen = b.length;
      chunks.push(b);
    });
    const tTextIn = serverNow();
    for (const w of SENTENCE.split(/(?<= )/)) {
      tts.pushText(w);
      await sleep(30);
    }
    const tFlush = serverNow();
    tts.flush();
    await tts.done();
    const tDone = serverNow();
    const pcm = Buffer.concat(chunks);
    const file = `out/tts-${model}.wav`;
    writeFileSync(file, writeWavPcm16(pcm, SAMPLE_RATE));
    const fb = marks.find((m) => m.name.endsWith("ttsFirstByte"));
    console.log(`connect ${(tReady - tOpen).toFixed(0)} ms`);
    console.log(`text-in → first byte ${fb ? (fb.t - tTextIn).toFixed(0) : "-"} ms (flush at +${(tFlush - tTextIn).toFixed(0)} ms, done at +${(tDone - tTextIn).toFixed(0)} ms)`);
    console.log(`first onAudio chunk ${firstChunkLen} bytes; total ${pcm.length} bytes = ${(pcm.length / (SAMPLE_RATE * 2)).toFixed(2)} s; chars ${tts.chars}`);
    for (const m of marks) console.log(`mark ${m.name} +${(m.t - tTextIn).toFixed(0)} ms ${JSON.stringify(m.meta ?? {})}`);
    console.log(`saved ${file} (listen to confirm it is speech, not noise: confirms pcm_24000 on this transport)`);
  } catch (e) {
    failed = true;
    console.error(`FAIL ${model}:`, e instanceof Error ? e.message : e);
  }
}
process.exit(failed ? 1 : 0);
