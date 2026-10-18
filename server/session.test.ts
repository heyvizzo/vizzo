import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { DEFAULT_CONFIG } from "../shared/config.ts";
import type { RunRecord, ServerMsg } from "../shared/protocol.ts";
import { createFakeDeps, DEFAULT_SCENARIO, FAST_TIMING } from "./orchestrators/fakes.ts";
import { createPipelineOrchestrator } from "./orchestrators/pipeline.ts";
import { Session } from "./session.ts";
import { getConversation } from "./conversation.ts";
import { resetThreadStore } from "./threads/store.ts";

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: (ServerMsg | Buffer)[] = [];
  send(data: string | Buffer) { this.sent.push(typeof data === "string" ? JSON.parse(data) : data); }
  client(msg: object) { this.emit("message", Buffer.from(JSON.stringify(msg)), false); }
}

async function turn(ws: FakeWs, turnId: string): Promise<RunRecord> {
  ws.client({ type: "turn.start", turnId, config: { ...DEFAULT_CONFIG, approach: "pipeline" }, tPress: 0 });
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

describe("Session + element threads", () => {
  const anchor = { pageUrl: "http://localhost/demo.html", selector: "#red", domPath: "body > #red", dataSource: null, label: null, text: null, role: null, tag: "button", bounds: { x: 0, y: 0, width: 1, height: 1 } };
  const msgs = (ws: FakeWs) => ws.sent.filter((m): m is ServerMsg => !Buffer.isBuffer(m));

  it("snapshot on connect; focus marks the result told; delete removes it everywhere; reset clears all", () => {
    const store = resetThreadStore();
    const t = store.create(anchor, "the red button", "task");
    store.update(t.threadId, (x) => { x.state = "pending"; x.unread = true; x.awaitingReply = true; });
    const ws = new FakeWs();
    const other = new FakeWs();
    new Session(ws as unknown as WebSocket, { orchestrators: {}, persist: false });
    new Session(other as unknown as WebSocket, { orchestrators: {}, persist: false });
    expect(msgs(ws)[0]).toMatchObject({ type: "threads.snapshot", threads: [{ threadId: t.threadId, state: "pending" }] });

    ws.client({ type: "thread.focus", threadId: t.threadId });
    expect(store.info(t.threadId)).toMatchObject({ state: "idle", unread: false, awaitingReply: false });
    expect(msgs(other).at(-1)).toMatchObject({ type: "thread", thread: { threadId: t.threadId, unread: false } });

    ws.client({ type: "thread.delete", threadId: t.threadId });
    expect(store.list()).toEqual([]);
    expect(msgs(other).at(-1)).toEqual({ type: "thread.removed", threadId: t.threadId });

    store.create(anchor, "the red button", "task");
    getConversation().push({ turnId: "x", approach: "pipeline", user: "u", assistant: "a", detail: "" });
    ws.client({ type: "conversation.reset" });
    expect(store.list()).toEqual([]);
    expect(getConversation()).toEqual([]);
    expect(msgs(other).at(-1)).toEqual({ type: "threads.snapshot", threads: [] });

    ws.emit("close");
    const n = ws.sent.length;
    store.create(anchor, "x", "task");
    expect(ws.sent.length).toBe(n); // unsubscribed
  });
  it("a turn routed to a thread credits its cost to the thread, tagged with the turn", async () => {
    const store = resetThreadStore();
    const t = store.create(anchor, "the red button", "task");
    const pipeline = createPipelineOrchestrator(createFakeDeps(FAST_TIMING, DEFAULT_SCENARIO));
    const ws = new FakeWs();
    new Session(ws as unknown as WebSocket, {
      orchestrators: { pipeline: (ctx) => { ctx.send({ type: "decision", turnId: ctx.turnId, intent: "task", estimateS: null, background: false, threadId: t.threadId }); return pipeline(ctx); } },
      persist: false,
    });
    const run = await turn(ws, "t1");
    expect(run.costItems?.length).toBeGreaterThan(0);
    const info = store.info(t.threadId)!;
    expect(info.costUsd).toBeCloseTo(run.costUsd);
    expect(info.costItems).toEqual(run.costItems!.map((i) => ({ ...i, turnId: "t1" })));
    ws.emit("close");
  });
});
