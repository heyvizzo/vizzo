import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../shared/config.ts";
import type { HarnessThread, OpenHarnessThreadOpts } from "../adapters/types.ts";
import type { AgentSpec } from "../adapters/harnesses.ts";
import { onActivity, runningTasks, type ActivityChange } from "../activity.ts";
import { createFakeDeps, DEFAULT_SCENARIO, FAST_TIMING } from "../orchestrators/fakes.ts";
import { loadThreads } from "./persist.ts";
import { submitRun, type RunSpec } from "./runner.ts";
import { INTERRUPTED_TEXT, resetThreadStore, ThreadStore } from "./store.ts";
import type { ThreadAnchor } from "../../shared/threads.ts";

const anchor = (selector: string): ThreadAnchor => ({
  pageUrl: "http://localhost/demo.html", selector, domPath: `body > ${selector}`, dataSource: null, label: null, text: null, role: null, tag: "button",
  bounds: { x: 0, y: 0, width: 10, height: 10 },
});

const spec = (question: string, kind: RunSpec["kind"] = "request"): RunSpec =>
  ({ kind, question, turnId: "t", config: DEFAULT_CONFIG, intent: "task" });
const SPEC: AgentSpec = { role: "solver", harness: "claude-code", model: "claude-opus-5-5", system: "S", project: "/proj", persist: true };

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vizzo-threads-"));
  file = join(dir, "threads.json");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); resetThreadStore(); });

describe("saved threads", () => {
  it("come back after a restart, with their messages and anchors", () => {
    const a = new ThreadStore();
    a.persistTo(file);
    const t = a.create(anchor("#red"), "the red button", "task");
    a.addMessage(t.threadId, { turnId: "t1", role: "user", kind: "request", text: "make it bigger" });
    a.update(t.threadId, (x) => { x.summary = "Made it bigger"; x.state = "pending"; x.unread = true; });
    a.flush();
    const b = new ThreadStore();
    b.persistTo(file);
    expect(b.list()).toEqual(a.list());
    expect(b.info(t.threadId)!.anchor.selector).toBe("#red");
  });

  it("a deleted thread and a new conversation are saved too", () => {
    const a = new ThreadStore();
    a.persistTo(file);
    const t1 = a.create(anchor("#a"), "a", "task");
    a.create(anchor("#b"), "b", "task");
    a.remove(t1.threadId);
    a.flush();
    expect(loadThreads(file).map((s) => s.info.title)).toEqual(["b"]);
    a.reset();
    a.flush();
    expect(loadThreads(file)).toEqual([]);
  });

  it("a thread that was working when the app closed comes back interrupted; its next run clears that", async () => {
    const a = new ThreadStore();
    a.persistTo(file);
    const t = a.create(anchor("#red"), "the red button", "task");
    a.update(t.threadId, (x) => { x.state = "running"; });
    a.flush();
    const b = new ThreadStore();
    b.persistTo(file);
    const info = b.info(t.threadId)!;
    expect(info).toMatchObject({ state: "idle", interrupted: true });
    expect(info.messages.at(-1)).toMatchObject({ kind: "interrupted", role: "system", text: INTERRUPTED_TEXT });
    const p = submitRun(t.threadId, spec("continue", "followup"), createFakeDeps(FAST_TIMING, { ...DEFAULT_SCENARIO, threadRunMs: 5 }), b);
    expect(b.info(t.threadId)!.interrupted).toBeUndefined();
    await p;
  });

  it("keeps what the thread's harness session needs to be resumed, and reopens it with that", async () => {
    const a = new ThreadStore();
    a.persistTo(file);
    const t = a.create(anchor("#red"), "the red button", "task");
    const choice = { provider: "claude-code" as const, model: "claude-opus-5-5" };
    a.get(t.threadId)!.handle = { id: "h", choice, spec: SPEC, live: false, session: () => ({ id: "sess-1" }), send: () => Promise.reject(new Error("unused")), abort() {}, close() {} } as HarnessThread;
    a.update(t.threadId, (x) => { x.summary = "x"; });
    a.flush();
    expect(loadThreads(file)[0]!.resume).toEqual({ choice, spec: SPEC, ref: { id: "sess-1" } });
    a.get(t.threadId)!.handle = null; // so a.reset() below has nothing to close

    const b = new ThreadStore();
    b.persistTo(file);
    const opened: OpenHarnessThreadOpts[] = [];
    const d = createFakeDeps(FAST_TIMING, { ...DEFAULT_SCENARIO, threadRunMs: 5 });
    const openThread = d.openThread!;
    await submitRun(t.threadId, spec("continue", "followup"), { ...d, openThread: (o) => { opened.push(o); return openThread(o); } }, b);
    expect(opened[0]).toMatchObject({ choice, restore: { spec: SPEC, ref: { id: "sess-1" } } });
    expect(b.get(t.threadId)!.resume).toBeUndefined();
  });

  it("an unreadable or foreign file is ignored", () => {
    writeFileSync(file, "{not json");
    expect(loadThreads(file)).toEqual([]);
    writeFileSync(file, JSON.stringify({ version: 99, threads: [{}] }));
    expect(loadThreads(file)).toEqual([]);
    expect(readFileSync(file, "utf8")).toContain("99");
  });
});

describe("activity", () => {
  it("a thread's run counts as working until it ends", async () => {
    const store = resetThreadStore();
    const changes: ActivityChange[] = [];
    const off = onActivity((c) => changes.push(c));
    const t = store.create(anchor("#red"), "the red button", "task");
    const p = submitRun(t.threadId, spec("make it bigger"), createFakeDeps(FAST_TIMING, { ...DEFAULT_SCENARIO, threadRunMs: 5 }), store);
    expect(runningTasks()).toEqual(["The red button"]);
    await p;
    await new Promise((r) => setTimeout(r, 0));
    off();
    expect(runningTasks()).toEqual([]);
    expect(changes.at(-1)).toEqual({ running: [], finished: { title: "The red button", outcome: "done" } });
  });
});
