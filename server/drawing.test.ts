import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { DrawingAnnotation } from "../shared/annotations.ts";
import { DEFAULT_CONFIG } from "../shared/config.ts";
import type { ServerMsg } from "../shared/protocol.ts";
import { annotation } from "./adapters/drawing.fixture.ts";
import { getConversation, resetConversation, retainConversationDrawings } from "./conversation.ts";
import { ConnectionState } from "./connection.ts";
import { createFakeDeps, DEFAULT_SCENARIO, FAST_TIMING } from "./orchestrators/fakes.ts";
import { createPipelineOrchestrator } from "./orchestrators/pipeline.ts";
import type { TurnContext } from "./orchestrators/types.ts";
import { Session } from "./session.ts";
import { replayAnnotations, replayText } from "./threads/runner.ts";
import { resetThreadStore } from "./threads/store.ts";

const waitUntil = async (ready: () => boolean) => {
  const deadline = Date.now() + 3000;
  while (!ready()) { if (Date.now() > deadline) throw new Error("timed out"); await new Promise(r => setTimeout(r, 5)); }
};
beforeEach(() => { resetConversation(); resetThreadStore(); });
afterEach(() => { resetConversation(); resetThreadStore(); });

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: ServerMsg[] = [];
  send(data: string | Buffer) { if (typeof data === "string") this.sent.push(JSON.parse(data)); }
  client(msg: object) { this.emit("message", Buffer.from(JSON.stringify(msg)), false); }
}

describe("drawing lifecycle", () => {
  it("validates ingress, passes attachment to the orchestrator, and retains it in run previews and central follow-ups", async () => {
    const ws = new FakeWs();
    let received: DrawingAnnotation | undefined;
    new Session(ws as unknown as WebSocket, { persist: false, orchestrators: { pipeline: ctx => {
      received = ctx.annotation;
      return { onAudio() {}, onRelease() {}, cancel() {}, done: Promise.resolve({ transcript: "move these", pointing: [], voiceText: "Done", solverText: "", usage: {} }) };
    } } });
    ws.client({ type: "turn.start", turnId: "drawing", config: { ...DEFAULT_CONFIG, approach: "pipeline", memory: true }, tPress: 0, text: "move these", annotation });
    await waitUntil(() => ws.sent.some(m => m.type === "turn.done"));
    const done = ws.sent.find(m => m.type === "turn.done");
    expect(received).toEqual(annotation);
    expect(done?.type === "turn.done" && done.run.annotation).toEqual(annotation);
    expect(getConversation().at(-1)?.annotation).toEqual(annotation);
    ws.emit("close");
  });

  it.each([false, true])("carries a multi-element drawing through router and %s background solver", async background => {
    const deps = createFakeDeps(FAST_TIMING, { ...DEFAULT_SCENARIO, estimateS: background ? 100 : 1 });
    const route = deps.routeTurn, solve = deps.solveTask;
    const seen: (DrawingAnnotation | undefined)[] = [];
    deps.routeTurn = opts => { seen.push(opts.annotation); return route(opts); };
    deps.solveTask = opts => { seen.push(opts.annotation); return solve(opts); };
    delete deps.openThread;
    delete deps.solveInThread;
    const events: ServerMsg[] = [];
    const ctx: TurnContext = {
      turnId: "d", config: { ...DEFAULT_CONFIG, approach: "pipeline", silent: true, memory: true, backgroundLongTasks: background },
      mark() {}, send: m => events.push(m), sendAudio() {}, cursorSamples: () => [], tAudioStart: () => undefined,
      typedText: "Move both marked regions", annotation, connection: new ConnectionState(),
      channel: { send: m => events.push(m), sendAudio() {}, whenIdle: async () => {}, isIdle: () => true, setNoticeAbort() {} },
    };
    const h = createPipelineOrchestrator(deps)(ctx);
    h.onRelease();
    const result = await h.done;
    expect(result.error).toBeUndefined();
    await waitUntil(() => seen.length === 2);
    expect(seen).toEqual([annotation, annotation]);
    if (background) await waitUntil(() => events.some(m => m.type === "job" && m.job.state === "done"));
  });

  it("bounds central retained drawings at four and preserves older geometry", () => {
    for (let i = 0; i < 6; i++) getConversation().push({ turnId: `t${i}`, approach: "pipeline", user: "move it", assistant: "done", detail: "", annotation: { ...annotation, id: `d${i}` } });
    retainConversationDrawings();
    expect(getConversation().filter(t => t.annotation).map(t => t.annotation!.id)).toEqual(["d2", "d3", "d4", "d5"]);
    expect(getConversation()[0]!.user).toContain("Drawing attachment d0");
    expect(getConversation()[0]!.user).not.toContain("base64");
  });

  it("retains eight images per thread and replays images only before the current message", () => {
    const store = resetThreadStore();
    const t = store.create({ pageUrl: annotation.pageUrl, selector: "#save", domPath: "body > #save", dataSource: null, label: "save", text: "Save", role: null, tag: "button", bounds: { x: 1, y: 2, width: 3, height: 4 } }, "save", "task");
    let current = "";
    for (let i = 0; i < 10; i++) current = store.addMessage(t.threadId, { turnId: `t${i}`, role: "user", kind: "request", text: "move", annotation: { ...annotation, id: `d${i}` } })!.id;
    const info = store.info(t.threadId)!;
    expect(info.messages.filter(m => m.annotation)).toHaveLength(8);
    expect(info.messages[0]!.text).toContain("preview expired");
    expect(replayAnnotations(info, current).map(a => a.id)).toEqual(["d2", "d3", "d4", "d5", "d6", "d7", "d8"]);
    expect(replayText(info, current)).toContain("Drawing attachment d8");
    expect(replayText(info, current)).not.toContain("Drawing attachment d9");
    expect(replayText(info, current)).not.toContain("base64");
  });
});
