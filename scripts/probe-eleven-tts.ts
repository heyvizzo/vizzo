// T1 probe: ElevenLabs streaming TTS over four sockets, run one after another:
//   A. TTS stream-input + eleven_flash_v2_5     B. TTS stream-input + eleven_v4_turbo (docs: unsupported)
//   C. Text-to-Dialogue stream-input + v4 Turbo  D. TTS multi-stream-input (2 contexts) + flash
// Logs each server message shape once (audio truncated), first-audio latency and close code.
// Run: npx tsx scripts/probe-eleven-tts.ts
import "dotenv/config";
import WebSocket from "ws";

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.log("SKIP: ELEVENLABS_API_KEY not set");
  process.exit(0);
}
const VOICE = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // docs' example voice
const WORDS = "Sure, one sec. The header is sticky so the navigation stays visible while you scroll. ".split(/(?<= )/);
const FMT = "output_format=pcm_24000";
const VS = { stability: 0.5, similarity_boost: 0.8, use_speaker_boost: false };

function sample(v: unknown, max = 500): string {
  const s = JSON.stringify(v, (_k, x) =>
    typeof x === "string" && x.length > 80 ? `<${x.length} chars>` : Array.isArray(x) && x.length > 6 ? [...x.slice(0, 6), `…+${x.length - 6}`] : x,
  );
  return s.length > max ? s.slice(0, max) + "…" : s;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runCase(name: string, url: string, msgs: unknown[]): Promise<void> {
  return new Promise((resolve) => {
    console.log(`\n=== ${name}\n${url.replace(VOICE, "{voice_id}")}`);
    const ws = new WebSocket(url, { headers: { "xi-api-key": KEY! } });
    const shapes = new Set<string>();
    let tSent = 0, bytes = 0, firstAudio = 0;
    const timer = setTimeout(() => ws.close(), 20_000);
    ws.on("unexpected-response", (_req, res) => console.log(`HTTP ${res.statusCode} on upgrade`));
    ws.on("error", (e) => console.log("socket error:", e.message));
    ws.on("open", async () => {
      tSent = Date.now();
      for (const m of msgs) {
        ws.send(JSON.stringify(m));
        await sleep(30); // simulate LLM token pacing
      }
    });
    ws.on("message", (raw) => {
      const ev = JSON.parse(raw.toString()) as Record<string, any>;
      if (typeof ev.audio === "string" && ev.audio) {
        bytes += Buffer.from(ev.audio, "base64").length;
        if (!firstAudio) firstAudio = Date.now() - tSent;
      }
      const shape = Object.keys(ev).sort().join(",");
      if (!shapes.has(shape)) {
        shapes.add(shape);
        console.log(`+${Date.now() - tSent}ms keys[${shape}]\n  ${sample(ev)}`);
      }
    });
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      console.log(`close ${code} ${reason.toString()} | first audio ${firstAudio || "-"} ms after first send | ${bytes} PCM bytes (${(bytes / 48000).toFixed(2)} s @24k)`);
      resolve();
    });
  });
}

const base = "wss://api.elevenlabs.io/v1";
const ttsMsgs = [
  { text: " ", voice_settings: VS, generation_config: { chunk_length_schedule: [50, 90, 120, 150] } },
  ...WORDS.map((w) => ({ text: w })),
  { text: " ", flush: true },
  { text: "" }, // EOS: server sends isFinal then closes
];

await runCase("A. stream-input / eleven_flash_v2_5", `${base}/text-to-speech/${VOICE}/stream-input?model_id=eleven_flash_v2_5&${FMT}`, ttsMsgs);
await runCase("B. stream-input / eleven_v4_turbo (expect rejection)", `${base}/text-to-speech/${VOICE}/stream-input?model_id=eleven_v4_turbo&${FMT}`, ttsMsgs);
await runCase("C. text-to-dialogue stream-input / eleven_v4_turbo", `${base}/text-to-dialogue/stream-input?model_id=eleven_v4_turbo&${FMT}`, [
  { voices: [VOICE] },
  ...WORDS.map((w) => ({ inputs: [{ text: w, voice_id: VOICE }] })),
  { flush: true }, // watch for is_final_audio_for_turn here
  { close_socket: true },
]);
await runCase("D. multi-stream-input / eleven_flash_v2_5 (ack + answer contexts)", `${base}/text-to-speech/${VOICE}/multi-stream-input?model_id=eleven_flash_v2_5&${FMT}`, [
  { text: " ", context_id: "ack", voice_settings: VS },
  { text: "One sec. ", context_id: "ack" },
  { context_id: "ack", flush: true },
  { text: " ", context_id: "answer" },
  ...WORDS.slice(3).map((w) => ({ text: w, context_id: "answer" })),
  { context_id: "answer", flush: true },
  { context_id: "ack", close_context: true },
  { context_id: "answer", close_context: true },
  { close_socket: true },
]);
process.exit(0);
