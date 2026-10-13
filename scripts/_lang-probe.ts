import "dotenv/config";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { DEFAULT_CONFIG, type Approach } from "../shared/config.ts";
import type { LlmPrompt, ServerMsg } from "../shared/protocol.ts";
import { startServer } from "../server/index.ts";
import { parseWav } from "../server/wav.ts";
// args: approach file [approach file …]; cursor rests on the CTA button the whole time
const pairs: [Approach, string][] = [];
for (let i = 2; i < process.argv.length; i += 2) pairs.push([process.argv[i] as Approach, process.argv[i + 1]!]);
const server = await startServer(0, { quiet: true, persist: false });
const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
await new Promise((r) => ws.once("open", r));
const cta = { elementPath: "main > section.hero > button.cta", dataSource: "web/cursor/demo/demo.html:27", label: "Get started", container: "Hero section" };
for (const [k, [approach, file]] of pairs.entries()) {
  const wav = parseWav(readFileSync(file));
  const turnId = `lang-${k}`;
  let voice = "", lang = "", prompts: LlmPrompt[] = [], rests = 0, targets = 0, decision = "";
  const done = new Promise<void>((res) => {
    const on = (d: WebSocket.RawData, bin: boolean) => {
      if (bin) return;
      const m = JSON.parse(d.toString()) as ServerMsg;
      if (!("turnId" in m) || m.turnId !== turnId) return;
      if (m.type === "voice.text") voice += m.delta;
      if (m.type === "stt.final") lang = `${m.language ?? "?"} · "${m.text}"`;
      if (m.type === "pointing.resolved") { rests = m.rests?.length ?? 0; targets = new Set(m.targets.map((t) => t.ref)).size; }
      if (m.type === "decision") decision = `${m.intent} ${m.estimateS ?? ""}`;
      if (m.type === "llm.prompt") prompts.push(m.prompt);
      if (m.type === "audio.segment" && m.state === "start") ws.send(JSON.stringify({ type: "audio.played", turnId, segment: m.segment, tPlayed: performance.now() }));
      if (m.type === "turn.done") { ws.off("message", on); res(); }
    };
    ws.on("message", on);
  });
  const t0 = performance.now();
  ws.send(JSON.stringify({ type: "turn.start", turnId, config: { ...DEFAULT_CONFIG, approach, memory: true, language: "auto", fillers: true, backgroundLongTasks: true, routerMode: "auto" }, tPress: t0 }));
  ws.send(JSON.stringify({ type: "turn.audioStart", turnId, tAudioStart: t0 }));
  const durMs = (wav.data.length / 48);
  const samples = Array.from({ length: Math.ceil((durMs + 600) / 16) }, (_, i) => ({ t: t0 - 200 + i * 16, x: 400, y: 380, scrollX: 0, scrollY: 0, ...cta }));
  ws.send(JSON.stringify({ type: "cursor.samples", turnId, samples }));
  for (let off = 0, j = 0; off < wav.data.length; off += 960, j++) {
    ws.send(wav.data.subarray(off, off + 960));
    const w = t0 + (j + 1) * 20 - performance.now(); if (w > 0) await new Promise((r) => setTimeout(r, w));
  }
  ws.send(JSON.stringify({ type: "turn.release", turnId, tRelease: performance.now() }));
  await done;
  console.log(`\n── ${approach} · ${file.split("/").pop()}`);
  console.log(`  heard: ${lang} · pointing words: ${targets} · rests: ${rests} · decision: ${decision}`);
  const first = prompts[0];
  if (first) console.log(`  ${first.target} prompt, this turn:\n    ` + first.messages.at(-1)!.text.split("\n").join("\n    "));
  console.log(`  bot: ${voice.trim()}`);
}
ws.close(); await server.close();
