import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../shared/config.ts";
import type { ServerMsg } from "../../shared/protocol.ts";
import type { ThreadAnchor } from "../../shared/threads.ts";
import { createFakeDeps, DEFAULT_SCENARIO, FAST_TIMING, type FakeScenario } from "../orchestrators/fakes.ts";
import { Floor } from "./floor.ts";
import { cancelRun, correctRun, replayText, submitRun, type RunSpec } from "./runner.ts";
import { resetThreadStore, type ThreadStore } from "./store.ts";

export const anchor = (selector: string): ThreadAnchor => ({
  pageUrl: "http://localhost/demo.html", selector, domPath: `body > ${selector}`, dataSource: null, label: null, text: null, role: null, tag: "button",
  bounds: { x: 0, y: 0, width: 10, height: 10 },
});

const spec = (question: string, kind: RunSpec["kind"] = "request"): RunSpec =>
  ({ kind, question, turnId: "t", config: DEFAULT_CONFIG, intent: "task" });

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

let store: ThreadStore;
let sent: ServerMsg[];
beforeEach(() => {
  store = resetThreadStore();
  sent = [];
});

const deps = (sc: Partial<FakeScenario> = {}) => createFakeDeps(FAST_TIMING, { ...DEFAULT_SCENARIO, threadRunMs: 30, ...sc });
const subscribe = () => {
  const floor = new Floor({ send: (m) => sent.push(m), sendAudio: () => {} }, { graceMs: 0, focused: () => store.focused() });
  store.subscribe({ send: (m) => sent.push(m), floor });
  return floor;
};
const says = () => sent.filter((m): m is Extract<ServerMsg, { type: "thread.say" }> => m.type === "thread.say" && m.state === "start").map((m) => m.say);

describe("thread runner", () => {
  it("queues a follow-up behind the current run, in one harness session", async () => {
    const d = deps();
    const t = store.create(anchor("#red"), "the red button", "task");
    const p1 = submitRun(t.threadId, spec("make it bigger"), d);
    const p2 = submitRun(t.threadId, spec("and round the corners", "followup"), d);
    expect(store.info(t.threadId)!.state).toBe("running");
    await p1;
    expect(d.log.threadSends).toHaveLength(1);
    expect(store.info(t.threadId)!.state).toBe("running"); // the follow-up is next
    await p2;
    expect(d.log.threadSends.map((s) => [s.threadId, s.kind])).toEqual([["thread#1", "request"], ["thread#1", "followup"]]);
    const info = store.info(t.threadId)!;
    expect(info.messages.filter((m) => m.kind === "result").map((m) => m.text)).toEqual(["Done: make it bigger", "Done: and round the corners"]);
    expect(info.summary).toBe("Done: and round the corners");
    expect(info.costItems?.[0]?.label).toMatch(/^Thread solver/);
    // The central conversation gets one line per finished run.
    expect(store.conversation.map((c) => c.assistant)).toEqual(["Red button task finished: Done: make it bigger", "Red button task finished: Done: and round the corners"]);
  });

  it("a correction aborts the current run and runs the combined request first", async () => {
    const d = deps({ threadRunMs: 60 });
    const t = store.create(anchor("#red"), "the red button", "task");
    const p1 = submitRun(t.threadId, spec("make it red"), d);
    await until(() => d.log.threadSends.length === 1);
    const p2 = correctRun(t.threadId, spec("actually make it green"), d);
    expect(await p1).toBeNull();
    const r = await p2;
    expect(d.log.threadAborts).toEqual(["thread#1"]);
    expect(d.log.threadSends[1]).toMatchObject({ kind: "correction" });
    expect(d.log.threadSends[1]!.question).toMatch(/^actually make it green[\s\S]*"make it red"/);
    expect(r?.spoken).toMatch(/^Done: actually make it green/);
    expect(store.info(t.threadId)!.messages.filter((m) => m.kind === "result")).toHaveLength(1);
  });

  it("stopped by the user: the run is aborted, its follow-ups dropped, nothing announced; the thread takes the next one", async () => {
    const d = deps({ threadRunMs: 60 });
    subscribe();
    const t = store.create(anchor("#red"), "the red button", "task");
    const p1 = submitRun(t.threadId, spec("make it red"), d);
    const p2 = submitRun(t.threadId, spec("and round it", "followup"), d);
    await until(() => d.log.threadSends.length === 1);
    expect(cancelRun(t.threadId)).toBe(true);
    expect(await p1).toBeNull();
    expect(await p2).toBeNull();
    expect(d.log.threadAborts).toEqual(["thread#1"]);
    const info = store.info(t.threadId)!;
    expect(info.state).toBe("idle");
    expect(info.messages.at(-1)).toMatchObject({ role: "system", kind: "stopped" });
    expect(info.messages.some((m) => m.kind === "result")).toBe(false);
    expect(says()).toEqual([]);
    expect(cancelRun(t.threadId)).toBe(false); // nothing running now
    // Same session, next request.
    const r = await submitRun(t.threadId, spec("make it blue"), d);
    expect(r?.spoken).toMatch(/^Done: make it blue/);
    expect(d.log.threadSends.map((s) => s.threadId)).toEqual(["thread#1", "thread#1"]);
  });

  it("reconcile: overlapping runs that touched a same file → one follow-up on the later-finishing thread", async () => {
    const d = deps({ filesTouched: ["web/demo.css"] });
    const a = store.create(anchor("#a"), "the red button", "task");
    const b = store.create(anchor("#b"), "the blue button", "task");
    const pa = submitRun(a.threadId, spec("A"), d);
    await new Promise((r) => setTimeout(r, 10));
    const pb = submitRun(b.threadId, spec("B"), d);
    await pa;
    await pb;
    await until(() => d.log.threadSends.length === 3);
    const rec = d.log.threadSends[2]!;
    expect(rec.kind).toBe("reconcile");
    expect(rec.threadId).toBe("thread#2");
    expect(rec.question).toBe("web/demo.css was also changed by another task meanwhile: re-read it and check your change is intact.");
    expect(store.info(b.threadId)!.messages.some((m) => m.kind === "reconcile")).toBe(true);
    expect(store.info(a.threadId)!.messages.some((m) => m.kind === "reconcile")).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(d.log.threadSends).toHaveLength(3); // the reconcile run doesn't trigger another one
  });

  it("no overlap, no reconcile", async () => {
    const d = deps({ filesTouched: ["web/demo.css"] });
    const a = store.create(anchor("#a"), "a", "task");
    const b = store.create(anchor("#b"), "b", "task");
    await submitRun(a.threadId, spec("A"), d);
    await submitRun(b.threadId, spec("B"), d);
    await new Promise((r) => setTimeout(r, 40));
    expect(d.log.threadSends).toHaveLength(2);
  });

  it("announces: the focused thread in full (then read, idle); another while the focused one runs → reminder, pending", async () => {
    subscribe();
    const d = deps();
    const t1 = store.create(anchor("#red"), "the red button", "task");
    const p1 = submitRun(t1.threadId, spec("bigger"), d);
    await new Promise((r) => setTimeout(r, 2));
    const t3 = store.create(anchor("#footer"), "the footer links", "task"); // focused now
    const p3 = submitRun(t3.threadId, { ...spec("lighter grey"), config: { ...DEFAULT_CONFIG } }, d);
    await p1;
    expect(store.info(t1.threadId)).toMatchObject({ state: "pending", unread: true, awaitingReply: false });
    await until(() => says().length === 1);
    expect(says()[0]).toMatchObject({ threadId: t1.threadId, needsReply: false, text: "An earlier task on the red button finished. Want me to tell you about it?" });
    await p3;
    await until(() => says().length === 2);
    expect(says()[1]).toMatchObject({ threadId: t3.threadId, needsReply: false, text: "Done: lighter grey" });
    await until(() => store.info(t3.threadId)!.unread === false);
    expect(store.info(t3.threadId)!.state).toBe("idle");
    expect(store.info(t1.threadId)!.state).toBe("pending"); // the reminder never tells the result itself
  });

  it("replay: the thread's history as plain text, up to the current request", () => {
    const t = store.create(anchor("#red"), "the red button", "task");
    store.addMessage(t.threadId, { turnId: "t1", role: "user", kind: "request", text: "make it bigger" });
    store.addMessage(t.threadId, { turnId: "t1", role: "assistant", kind: "ack", text: "Sure." });
    store.addMessage(t.threadId, { turnId: "t1", role: "assistant", kind: "result", text: "Done.", detail: "SPOKEN: Done.\n\nPadding 12px.", filesTouched: ["a.css"] });
    const m = store.addMessage(t.threadId, { turnId: "t2", role: "user", kind: "followup", text: "rounder" })!;
    const r = replayText(store.info(t.threadId), m.id);
    expect(r).toContain("User (request): make it bigger");
    expect(r).toContain("Padding 12px.\n(Edited: a.css)");
    expect(r).not.toContain("rounder");
    expect(r).not.toContain("Sure.");
  });
});

describe("thread store", () => {
  it("snapshot on subscribe, broadcasts changes and removals; remove stops the run and closes the session", async () => {
    const d = deps({ threadRunMs: 200 });
    const t = store.create(anchor("#red"), "the red button", "task");
    subscribe();
    expect(sent[0]).toMatchObject({ type: "threads.snapshot", threads: [{ threadId: t.threadId }] });
    const p = submitRun(t.threadId, spec("bigger"), d);
    expect(sent.filter((m) => m.type === "thread").at(-1)).toMatchObject({ thread: { threadId: t.threadId, state: "running" } });
    expect(sent.find((m) => m.type === "llm.prompt")).toMatchObject({ jobId: t.threadId }); // a background run's trace
    await until(() => d.log.threadSends.length === 1);
    store.conversation.push({ turnId: "x", approach: "pipeline", user: "(Task update)", assistant: "Started a task on the red button: bigger", detail: "" });
    expect(store.remove(t.threadId)).toBe(true);
    expect(await p).toBeNull();
    expect(d.log.threadClosed).toEqual(["thread#1"]);
    expect(sent.at(-1)).toEqual({ type: "thread.removed", threadId: t.threadId });
    expect(store.conversation).toHaveLength(1); // central lines stay
  });

  it("focus: latest interaction, result counts as told; reset clears threads and the conversation", () => {
    const a = store.create(anchor("#a"), "a", "task");
    store.create(anchor("#b"), "b", "task");
    store.update(a.threadId, (t) => { t.state = "pending"; t.unread = true; t.awaitingReply = true; });
    store.focus(a.threadId);
    expect(store.focused()).toBe(a.threadId);
    expect(store.info(a.threadId)).toMatchObject({ state: "idle", unread: false, awaitingReply: false });
    store.conversation.push({ turnId: "x", approach: "pipeline", user: "u", assistant: "a", detail: "" });
    subscribe();
    store.reset();
    expect(store.list()).toEqual([]);
    expect(store.conversation).toEqual([]);
    expect(sent.at(-1)).toEqual({ type: "threads.snapshot", threads: [] });
  });
});
