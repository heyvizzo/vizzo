// T4 smoke: OpenAI Realtime adapter against the real API.
//   npm run smoke:realtime [-- --model gpt-realtime-2.1-mini]
// Case 1: stream fixtures/smoke/hello.wav, commit, save reply to out/realtime-reply.wav, print marks.
// Case 2: instruct the model to always call ask_opus, return a fake result, print the answer-segment marks.
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { serverNow } from "../server/clock.ts";
import { openRealtime } from "../server/adapters/openaiRealtime.ts";
import { ASK_OPUS_TOOL, type Mark } from "../server/adapters/types.ts";
import type { RealtimeModel } from "../shared/config.ts";
import { parseWav, writeWavPcm16 } from "./lib/wav.ts";

if (!process.env.OPENAI_API_KEY) {
  console.log("SKIP: OPENAI_API_KEY not set (smoke:realtime)");
  process.exit(0);
}

const argModel = process.argv.indexOf("--model");
const model = (argModel >= 0 ? process.argv[argModel + 1] : "gpt-realtime-2.1") as RealtimeModel;
if (model !== "gpt-realtime-2.1" && model !== "gpt-realtime-2.1-mini") {
  console.error(`unknown model ${model}`);
  process.exit(1);
}

const wav = parseWav(readFileSync(new URL("../fixtures/smoke/hello.wav", import.meta.url)));
if (wav.sampleRate !== 24000 || wav.channels !== 1 || wav.bitsPerSample !== 16) {
  throw new Error(`hello.wav must be 24 kHz PCM16 mono, got ${wav.sampleRate} Hz ${wav.channels}ch ${wav.bitsPerSample}-bit`);
}

function markRecorder(label: string) {
  const list: { name: string; t: number; meta?: Record<string, unknown> }[] = [];
  const mark: Mark = (name, meta) => list.push({ name, t: serverNow(), meta });
  const print = (t0: number) => {
    console.log(`  marks (${label}, ms since release):`);
    for (const m of list) console.log(`    ${m.name.padEnd(22)} ${(m.t - t0).toFixed(0).padStart(6)}${m.meta ? " " + JSON.stringify(m.meta) : ""}`);
  };
  return { mark, print, list };
}

/** Stream fixture audio in 100 ms chunks. Real-time pacing isn't needed for push-to-talk. */
function streamFixture(push: (b: Buffer) => void) {
  const chunk = 4800; // 100 ms of PCM16 @ 24 kHz
  for (let i = 0; i < wav.data.length; i += chunk) push(wav.data.subarray(i, i + chunk));
}

async function case1() {
  console.log(`\n[case 1] hello.wav → reply audio (${model})`);
  const rec = markRecorder("case 1");
  const tOpen = serverNow();
  const s = await openRealtime({ mark: rec.mark, model, instructions: "You are a friendly, terse voice assistant. Reply in one short sentence.", tools: [] });
  console.log(`  session ready in ${(serverNow() - tOpen).toFixed(0)} ms`);
  const audio: Buffer[] = [];
  let transcript = "";
  s.onAudio((b) => audio.push(b));
  s.onText((d) => (transcript += d));
  s.onError((e) => console.log("  error:", e.message));
  s.beginTurn();
  streamFixture((b) => s.pushAudio(b));
  const release = serverNow();
  s.commitAndRespond();
  await s.responseDone();
  const pcm = Buffer.concat(audio);
  mkdirSync("out", { recursive: true });
  writeFileSync("out/realtime-reply.wav", writeWavPcm16(pcm, 24000));
  console.log(`  transcript: ${JSON.stringify(transcript)}`);
  console.log(`  saved out/realtime-reply.wav (${(pcm.length / 48000).toFixed(2)} s)`);
  rec.print(release);
  console.log("  usage totals:", JSON.stringify(s.usage.totals));
  s.close();
}

async function case2() {
  console.log(`\n[case 2] forced ask_opus tool call (${model})`);
  const rec = markRecorder("case 2");
  const s = await openRealtime({
    mark: rec.mark,
    model,
    instructions:
      "You are a voice assistant. For EVERY user turn, first say a very short acknowledgment like 'One sec.', " +
      "then ALWAYS call the ask_opus tool with the user's question. After the tool result arrives, speak its answer briefly.",
    tools: [ASK_OPUS_TOOL],
  });
  let transcript = "";
  s.onText((d) => (transcript += d));
  s.onError((e) => console.log("  error:", e.message));
  const toolCall = new Promise<{ callId: string; name: string; args: unknown }>((res) => s.onToolCall(res));
  s.beginTurn();
  streamFixture((b) => s.pushAudio(b));
  const release = serverNow();
  s.commitAndRespond("The user is pointing at the sticky header. Call ask_opus with: 'Why is the header sticky?'");
  const timeout = new Promise<null>((res) => setTimeout(() => res(null), 30_000));
  const call = await Promise.race([toolCall, timeout]);
  if (!call) {
    console.log("  FAIL: no tool call within 30 s");
    rec.print(release);
    s.close();
    process.exitCode = 1;
    return;
  }
  console.log(`  tool call: ${call.name} ${JSON.stringify(call.args)}`);
  s.sendToolResult(call.callId, "SPOKEN: The header is sticky so navigation stays visible while scrolling long pages.");
  await s.responseDone(); // ack response
  if (s.currentSegment !== "answer") await s.responseDone(); // answer response
  console.log(`  transcript: ${JSON.stringify(transcript)}`);
  rec.print(release);
  const ans = rec.list.find((m) => m.name === "answer.ttsFirstByte");
  console.log(`  answer segment: ${ans ? `answer.ttsFirstByte at ${(ans.t - release).toFixed(0)} ms` : "MISSING answer.ttsFirstByte"}`);
  console.log("  usage totals:", JSON.stringify(s.usage.totals), `(${s.usage.responses.length} responses)`);
  s.close();
}

try {
  await case1();
  await case2();
} catch (e) {
  console.error("smoke:realtime failed:", e);
  process.exit(1);
}
