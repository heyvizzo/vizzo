import { afterEach, describe, expect, it, vi } from "vitest";
import { continueSession, prepareSessionResume } from "../shared/sessionResume.ts";
import { backgroundCentralSession, centralSession, finishJobSession, solveCentral } from "./centralSession.ts";
import { getConversation } from "./conversation.ts";
import type { HarnessThread } from "./adapters/types.ts";
import { startServer, type RunningServer } from "./index.ts";
import { resetThreadStore } from "./threads/store.ts";

let server: RunningServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; resetThreadStore(); });

async function fixture(release: () => Promise<void>) {
  const store = resetThreadStore();
  const t = store.create({ pageUrl: "http://test/", selector: "#x", domPath: "body > #x", dataSource: null, label: null, text: null, role: null, tag: "button", bounds: { x: 0, y: 0, width: 1, height: 1 } }, "button", "task");
  store.get(t.threadId)!.handle = { session: () => ({ id: "native-session" }), release } as unknown as HarnessThread;
  server = await startServer(0, { host: "127.0.0.1", quiet: true, persist: false });
  return `http://127.0.0.1:${server.port}`;
}

describe("preparing terminal resume", () => {
  it("releases and continues a completed task after the main conversation has moved to a new handle", async () => {
    const release = vi.fn(async () => {});
    const close = vi.fn();
    const handle = {
      id: "old-central", choice: { provider: "codex", model: "m" },
      session: () => ({ id: "completed-native" }), release, close,
    } as unknown as HarnessThread;
    const reserved = { close: vi.fn(), session: () => undefined } as unknown as HarnessThread;
    let opened = false;
    await solveCentral({ openThread: () => { if (opened) return reserved; opened = true; return handle; }, solveInThread: async () => ({ text: "done", usage: {}, filesTouched: [] }) },
      { provider: "codex", model: "m" }, "original", { mark: () => {}, question: "original", pointing: [], onDelta: () => {}, onSpokenLine: () => {} });
    // A distinct continuation, as allocated by a real handoff.
    backgroundCentralSession(handle);
    expect(centralSession()).toBe(reserved);
    await finishJobSession(handle);
    server = await startServer(0, { host: "127.0.0.1", quiet: true, persist: false });
    const base = `http://127.0.0.1:${server.port}`;
    await prepareSessionResume("completed-native", base);
    await continueSession("completed-native", base, "original task");
    expect(centralSession()).toBe(handle);
    expect(release).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
    expect(getConversation().at(-1)?.user).toContain("original task");
    await expect(continueSession("unknown", base)).rejects.toThrow("no longer available");
  });

  it("does not acknowledge the HTTP request until the native writer has closed", async () => {
    let finish!: () => void;
    let started!: () => void;
    const releasing = new Promise<void>((resolve) => { started = resolve; });
    const release = vi.fn(() => { started(); return new Promise<void>((resolve) => { finish = resolve; }); });
    const base = await fixture(release);
    let ready = false;
    const request = prepareSessionResume("native-session", base).then(() => { ready = true; });
    await releasing;
    expect(ready).toBe(false);
    finish();
    await request;
    expect(ready).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });

  it("propagates release errors and refuses an unrelated session id", async () => {
    const release = vi.fn(async () => { throw new Error("Codex still owns the session"); });
    const base = await fixture(release);
    await expect(prepareSessionResume("native-session", base)).rejects.toThrow("Codex still owns the session");
    await expect(prepareSessionResume("another-session", base)).rejects.toThrow("no longer available");
    expect(release).toHaveBeenCalledOnce();
    expect((await fetch(`${base}/api/sessions/release`, { method: "POST", body: "{}" })).status).toBe(400);
  });
});
