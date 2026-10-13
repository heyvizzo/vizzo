// T1 probe: OpenAI Realtime (GA) over raw WebSocket. Logs every server event type once
// (truncated sample) plus counts. Run: npx tsx scripts/probe-openai-realtime.ts
import "dotenv/config";
import WebSocket from "ws";

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.log("SKIP: OPENAI_API_KEY not set");
  process.exit(0);
}
const MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1";

/** 1 s of a 440 Hz tone, PCM16 mono 24 kHz little-endian. */
function tone(seconds = 1, hz = 440, rate = 24000): Buffer {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), i * 2);
  return buf;
}

/** JSON with long strings / arrays shortened, capped at `max` chars. */
function sample(v: unknown, max = 600): string {
  const s = JSON.stringify(v, (_k, x) =>
    typeof x === "string" && x.length > 80 ? `<${x.length} chars>` : Array.isArray(x) && x.length > 6 ? [...x.slice(0, 6), `…+${x.length - 6}`] : x,
  );
  return s.length > max ? s.slice(0, max) + "…" : s;
}

const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
  headers: { Authorization: `Bearer ${KEY}` }, // GA: no OpenAI-Beta header
});
const send = (ev: Record<string, unknown>) => ws.send(JSON.stringify(ev));
const seen = new Map<string, number>();
const t0 = Date.now();
let responses = 0;
let toolDone = false;

ws.on("open", () => console.log(`open ${MODEL} after ${Date.now() - t0} ms`));
ws.on("unexpected-response", (_req, res) => console.log(`HTTP ${res.statusCode} on upgrade`));
ws.on("error", (e) => console.log("socket error:", e.message));
ws.on("close", (code, reason) => {
  console.log(`\nclose ${code} ${reason.toString()}\nevent counts:`, Object.fromEntries(seen));
  process.exit(0);
});

ws.on("message", (raw) => {
  const ev = JSON.parse(raw.toString()) as Record<string, any>;
  const type = String(ev.type);
  const n = (seen.get(type) ?? 0) + 1;
  seen.set(type, n);
  if (n === 1) console.log(`+${Date.now() - t0}ms ${type}\n  ${sample(ev)}`);

  if (type === "session.created") {
    send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: "You are a terse voice assistant. Before calling a tool, say 'One sec.'",
        output_modalities: ["audio"],
        audio: {
          input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: null },
          output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" },
        },
        tools: [
          {
            type: "function",
            name: "ask_opus",
            description: "Delegate a hard question about the codebase.",
            parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
          },
        ],
        tool_choice: "auto",
      },
    });
  } else if (type === "session.updated" && responses === 0) {
    send({ type: "input_audio_buffer.clear" });
    const pcm = tone();
    for (let i = 0; i < pcm.length; i += 4800) send({ type: "input_audio_buffer.append", audio: pcm.subarray(i, i + 4800).toString("base64") });
    send({ type: "input_audio_buffer.commit" });
    send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Ignore the tone. Call ask_opus with question 'why is the header sticky?'" }],
      },
    });
    send({ type: "response.create" });
    responses = 1;
  } else if (type === "response.output_item.added" && ev.item?.type === "function_call") {
    console.log(`  >> tool call started: name=${ev.item.name} call_id=${ev.item.call_id}`);
  } else if (type === "response.done") {
    console.log(`  >> status=${ev.response?.status} usage=${sample(ev.response?.usage, 2000)}`);
    const call = (ev.response?.output ?? []).find((o: any) => o.type === "function_call");
    if (call && !toolDone) {
      toolDone = true;
      send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ answer: "It keeps nav visible." }) },
      });
      send({ type: "response.create" });
      responses++;
    } else ws.close();
  } else if (type === "error") {
    console.log(`  >> error: ${sample(ev.error)}`);
  }
});

setTimeout(() => {
  console.log("timeout after 45 s");
  ws.close();
}, 45_000);
