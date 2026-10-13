import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { DEFAULT_CONFIG } from "../shared/config.ts";
import type { RunRecord, ServerMsg } from "../shared/protocol.ts";
import { createFakeDeps, DEFAULT_SCENARIO, FAST_TIMING } from "./orchestrators/fakes.ts";
import { createRealtimeOrchestrator } from "./orchestrators/realtime.ts";
import { Session } from "./session.ts";

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: (ServerMsg | Buffer)[] = [];
  send(data: string | Buffer) { this.sent.push(typeof data === "string" ? JSON.parse(data) : data); }
  client(msg: object) { this.emit("message", Buffer.from(JSON.stringify(msg)), false); }
}

async function turn(ws: FakeWs, turnId: string): Promise<RunRecord> {
  ws.client({ type: "turn.start", turnId, config: { ...DEFAULT_CONFIG, approach: "realtime" }, tPress: 0 });
  ws.emit("message", Buffer.alloc(960), true);
  ws.client({ type: "turn.release", turnId, tRelease: 1 });
  // Headless client: report audio.played as soon as a segment starts.
  for (;;) {
    await new Promise((r) => setTimeout(r, 2));
    for (const m of ws.sent.splice(0)) {
      if (Buffer.isBuffer(m)) continue;
      if (m.type === "audio.segment" && m.state === "start") ws.client({ type: "audio.played", turnId, segment: m.segment, tPlayed: 2 });
      if (m.type === "turn.done") return m.run;
    }
  }
}

describe("Session + realtime orchestrator", () => {
  it("renames ack marks to answer when the model answered without ask_opus (TTA = TTFA)", async () => {
    const ws = new FakeWs();
    const deps = createFakeDeps(FAST_TIMING, { ...DEFAULT_SCENARIO, delegate: false });
    new Session(ws as unknown as WebSocket, { orchestrators: { realtime: createRealtimeOrchestrator(deps) }, persist: false });
    const run = await turn(ws, "t1");
    expect(run.error).toBeUndefined();
    expect(run.marks["ack.played"]).toBeUndefined();
    expect(run.marks["ack.ttsFirstByte"]).toBeUndefined();
    expect(run.marks["answer.played"]).toBe(2);
    expect(run.markMeta?.["answer.played"]).toMatchObject({ relabeledFrom: "ack.played" });
    expect(run.metrics.tta).toBe(1);
    expect(run.metrics.ttfa).toBe(1);
  });

  it("keeps ack and answer separate when delegated; disposes the reused session on close", async () => {
    const ws = new FakeWs();
    const deps = createFakeDeps(FAST_TIMING, DEFAULT_SCENARIO);
    new Session(ws as unknown as WebSocket, { orchestrators: { realtime: createRealtimeOrchestrator(deps) }, persist: false });
    const run = await turn(ws, "t1");
    expect(run.marks["ack.played"]).toBe(2);
    expect(run.marks["answer.played"]).toBe(2);
    expect(run.marks["opus.request"]).toBeDefined();
    expect(run.voiceText).toMatch(/now\. The grid/);
    expect(run.usage.openai).toBeDefined();
    await turn(ws, "t2");
    expect(deps.log.opened.filter((id) => id.startsWith("realtime"))).toHaveLength(1);
    ws.emit("close");
    await new Promise((r) => setTimeout(r, 1));
    expect(deps.log.closed.filter((id) => id.startsWith("realtime"))).toHaveLength(1);
  });
});
