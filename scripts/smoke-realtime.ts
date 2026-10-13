// T4 smoke: OpenAI Realtime adapter against the real API.
//   npm run smoke:realtime [-- --model gpt-realtime-2.1-mini]
// Case 1: stream fixtures/smoke/hello.wav, commit, save reply to out/realtime-reply.wav, print marks.
// Case 2: instruct the model to always call ask_opus, return a fake result, print the answer-segment marks.
// Case 3: speak() a filler (out-of-band) and a notice on an idle session → out/realtime-{filler,notice}.wav.
// Case 4: cancelResponse() after the first audio delta, beginTurn() + a normal turn; checks no stale audio leaks.
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { serverNow } from "../server/clock.ts";
import WebSocket from "ws";
import { createOpenRealtime, openRealtime, type RealtimeSocketCtor } from "../server/adapters/openaiRealtime.ts";
import { ASK_OPUS_TOOL, type Mark } from "../server/adapters/types.ts";
import type { RealtimeModel } from "../shared/config.ts";
import { parseWav, writeWavPcm16 } from "../server/wav.ts";

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
if (wav.sampleRate !== 24000 || wav.channels !== 1) {
  throw new Error(`hello.wav must be 24 kHz PCM16 mono, got ${wav.sampleRate} Hz ${wav.channels}ch`);
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
  await s.responseDone(); // waits for the ack and the queued answer response
  console.log(`  transcript: ${JSON.stringify(transcript)}`);
  rec.print(release);
  const ans = rec.list.find((m) => m.name === "answer.ttsFirstByte");
  console.log(`  answer segment: ${ans ? `answer.ttsFirstByte at ${(ans.t - release).toFixed(0)} ms` : "MISSING answer.ttsFirstByte"}`);
  console.log("  usage totals:", JSON.stringify(s.usage.totals), `(${s.usage.responses.length} responses)`);
  s.close();
}

/** A `ws` WebSocket that records every server event, so the smoke can inspect what the adapter filtered. */
function tappedOpen() {
  const events: Record<string, any>[] = [];
  class Tapped extends (WebSocket as any) {
    constructor(url: string, opts: unknown) {
      super(url, opts);
      (this as any).on("message", (d: Buffer) => {
        try {
          events.push(JSON.parse(d.toString("utf8")));
        } catch {
          /* ignore */
        }
      });
    }
  }
  return { open: createOpenRealtime({ WebSocket: Tapped as unknown as RealtimeSocketCtor }), events };
}

/** Raw audio bytes per response id, from tapped server events. */
function audioBytesById(events: Record<string, any>[]) {
  const m = new Map<string, number>();
  for (const e of events) {
    if (e.type === "response.output_audio.delta") m.set(e.response_id, (m.get(e.response_id) ?? 0) + Buffer.from(e.delta, "base64").length);
  }
  return m;
}

async function case3() {
  console.log(`\n[case 3] speak(): filler (out-of-band) + notice (in-conversation) on an idle session (${model})`);
  const { open, events } = tappedOpen();
  const rec = markRecorder("case 3");
  const s = await open({
    mark: rec.mark,
    model,
    instructions: "You are a friendly voice assistant for a web developer. Keep replies short.",
    tools: [ASK_OPUS_TOOL],
  });
  s.onError((e) => console.log("  error:", e.message));
  let audio: Buffer[] = [];
  let transcript = "";
  s.onAudio((b) => audio.push(b));
  s.onText((d) => (transcript += d));
  mkdirSync("out", { recursive: true });

  for (const [kind, text, file] of [
    ["filler", "Still checking the stylesheet.", "out/realtime-filler.wav"],
    ["notice", "the CSS refactor finished; 3 files changed and the build passes", "out/realtime-notice.wav"],
  ] as const) {
    audio = [];
    transcript = "";
    const from = events.length;
    const t0 = serverNow();
    let firstAudio = 0;
    s.onAudio(() => (firstAudio ||= serverNow()));
    await s.speak(text, kind);
    const pcm = Buffer.concat(audio);
    writeFileSync(file, writeWavPcm16(pcm, 24000));
    const evs = events.slice(from);
    const created = evs.find((e) => e.type === "response.created")?.response;
    const done = evs.find((e) => e.type === "response.done")?.response;
    console.log(`  ${kind}: asked ${JSON.stringify(text)}`);
    console.log(`    said:        ${JSON.stringify(transcript)}`);
    console.log(`    first audio: ${firstAudio ? (firstAudio - t0).toFixed(0) + " ms" : "none"}, done ${(serverNow() - t0).toFixed(0)} ms; saved ${file} (${(pcm.length / 48000).toFixed(2)} s)`);
    console.log(`    response.created: conversation_id=${JSON.stringify(created?.conversation_id)} metadata=${JSON.stringify(created?.metadata)}`);
    console.log(`    response.done: status=${done?.status} usage=${JSON.stringify(done?.usage?.output_token_details)} in=${done?.usage?.input_tokens}`);
    console.log(`    event types: ${[...new Set(evs.map((e) => e.type))].join(", ")}`);
    if (kind === "filler") {
      const norm = (x: string) => x.toLowerCase().replace(/[^a-z ]/g, "").trim();
      console.log(`    verbatim: ${norm(transcript) === norm(text) ? "YES" : "NO"}`);
    }
  }
  console.log(`  marks (should be none): ${JSON.stringify(rec.list.map((m) => m.name))}`);
  console.log("  usage totals:", JSON.stringify(s.usage.totals), `(${s.usage.responses.length} responses)`);
  s.close();
}

async function case4() {
  console.log(`\n[case 4] cancelResponse() after first audio, then beginTurn() + a normal turn on the same session (${model})`);
  const { open, events } = tappedOpen();
  const rec = markRecorder("case 4");
  const s = await open({
    mark: rec.mark,
    model,
    instructions: "You are a voice assistant. Answer every user turn in about four sentences.",
    tools: [],
  });
  s.onError((e) => console.log("  error:", e.message));
  let phase: "first" | "second" = "first";
  const delivered = { first: 0, second: 0 };
  let transcript2 = "";
  let cancelledAt = -1;
  s.onText((d) => phase === "second" && (transcript2 += d));
  let resolveFirst!: () => void;
  const firstAudio = new Promise<void>((r) => (resolveFirst = r));
  s.onAudio((b) => {
    delivered[phase] += b.length;
    if (phase === "first" && cancelledAt < 0) {
      cancelledAt = events.length;
      s.cancelResponse();
      resolveFirst();
    }
  });
  s.beginTurn();
  streamFixture((b) => s.pushAudio(b));
  s.commitAndRespond();
  await firstAudio;
  // Barge-in: new turn right away, before the cancelled response's response.done.
  const rec2 = markRecorder("case 4 turn 2");
  s.setMark(rec2.mark);
  phase = "second";
  s.beginTurn();
  streamFixture((b) => s.pushAudio(b));
  const release = serverNow();
  s.commitAndRespond();
  await s.responseDone();
  // Let any trailing events arrive.
  await new Promise((r) => setTimeout(r, 300));

  const ids = [...new Set(events.filter((e) => e.type === "response.created").map((e) => e.response.id))];
  const bytes = audioBytesById(events);
  const dones = events.filter((e) => e.type === "response.done").map((e) => e.response);
  for (const id of ids) {
    const d = dones.find((r) => r.id === id);
    console.log(`  ${id}: raw audio ${bytes.get(id) ?? 0} B, status=${d?.status} ${JSON.stringify(d?.status_details ?? null)}`);
    const said = events.filter((e) => e.type === "response.output_audio_transcript.delta" && e.response_id === id).map((e) => e.delta).join("");
    console.log(`    raw transcript: ${JSON.stringify(said)}`);
  }
  const lateOld = events.slice(cancelledAt).filter((e) => e.type === "response.output_audio.delta" && e.response_id === ids[0]).length;
  console.log(`  cancelled response: ${lateOld} audio deltas arrived after cancelResponse()`);
  console.log(`  delivered to onAudio: first turn ${delivered.first} B, second turn ${delivered.second} B`);
  const ok = ids.length === 2 && delivered.second === (bytes.get(ids[1]!) ?? 0);
  console.log(`  no stale leak: ${ok ? "YES" : "NO"} (second turn delivered == raw bytes of ${ids[1]})`);
  if (!ok) process.exitCode = 1;
  console.log(`  turn 2 transcript: ${JSON.stringify(transcript2)}`);
  const errs = events.filter((e) => e.type === "error");
  if (errs.length) console.log("  server errors:", JSON.stringify(errs.map((e) => e.error)));
  rec2.print(release);
  s.close();
}

try {
  await case1();
  await case2();
  await case3();
  await case4();
} catch (e) {
  console.error("smoke:realtime failed:", e);
  process.exit(1);
}
