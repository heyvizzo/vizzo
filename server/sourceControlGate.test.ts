import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { ServerMsg } from "../shared/protocol.ts";
import type { ChangesService } from "./changes/changesService.ts";
import { startServer } from "./index.ts";
import { resetThreadStore } from "./threads/store.ts";

const anchor = {
  pageUrl: "http://localhost/", selector: "button", domPath: "body > button", tag: "button",
  text: null, role: null, label: null, dataSource: null, bounds: { x: 0, y: 0, width: 16, height: 16 },
};

it("honors the saved opt-in on direct routes and preserves Keep deletion and socket sessions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vizzo-source-control-gate-"));
  const settings = join(directory, "settings.json");
  vi.stubEnv("VIZZO_SETTINGS_FILE", settings);
  const store = resetThreadStore();
  const a = store.create(anchor, "first", "task");
  const b = store.create(anchor, "second", "task");
  const c = store.create(anchor, "third", "task");
  for (const thread of [a, b, c]) store.get(thread.threadId)!.projectFolder = directory;
  store.update(b.threadId, (thread) => { thread.state = "running"; });
  const deleteThreads = vi.fn<ChangesService["deleteThreads"]>(async (targets, ports) => {
    await ports.prepare?.();
    ports.verifyCommit?.();
    await ports.remove(targets.map(({ threadId }) => threadId));
    return [];
  });
  let resolveReview: (receipts: Awaited<ReturnType<ChangesService["previewThreadDeletes"]>>) => void = () => {};
  const previewThreadDeletes = vi.fn<ChangesService["previewThreadDeletes"]>(() => new Promise((resolve) => { resolveReview = resolve; }));
  let notifyStatus = () => {};
  let status: "none" | "loading" = "none";
  const service = {
    scanner: { status: () => ({ kind: status }), subscribeStatus: (notify: () => void) => { notifyStatus = notify; return () => {}; } },
    previewThreadDeletes, deleteThreads,
  } as unknown as ChangesService;
  const server = await startServer(0, { host: "127.0.0.1", quiet: true, changes: { service } });
  const origin = `http://127.0.0.1:${server.port}`;
  const sockets: WebSocket[] = [];
  const connect = (view = "", source = origin) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws${view}`, { origin: source });
    sockets.push(ws);
    const received: ServerMsg[] = [];
    ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    return { ws, received, send: (message: object) => ws.send(JSON.stringify(message)) };
  };
  const save = (gitSourceControl: boolean) => {
    writeFileSync(settings, JSON.stringify({ chat: JSON.stringify({ gitSourceControl }) }));
    server.refreshSourceControl();
  };
  const off = { reason: "Git source control is disabled" };
  try {
    for (const suffix of ["", "/status", "/diff", "/jobs", "/message", "/commit", "/fix", "/restart"]) {
      const response = await fetch(`${origin}/api/changes${suffix}`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(off);
    }
    const blockedWatcher = connect("?view=changes");
    expect(await once(blockedWatcher.ws, "close")).toEqual([1008, Buffer.from(off.reason)]);
    const chat = connect();
    await once(chat.ws, "open");
    chat.send({ type: "thread.delete.preview", requestId: "off", threadIds: [a.threadId, b.threadId] });
    await vi.waitFor(() => expect(chat.received).toContainEqual({ type: "thread.delete.preview", requestId: "off", threads: [
      { threadId: a.threadId, state: "none", defaultMode: "keep" }, { threadId: b.threadId, state: "working", defaultMode: "keep" },
    ] }));
    expect(previewThreadDeletes).not.toHaveBeenCalled();
    for (const type of ["thread.delete", "threads.delete", "conversation.reset"]) {
      const choice = { threadId: a.threadId, mode: "commit" };
      chat.send({ type, requestId: type, ...(type === "thread.delete" ? choice : { threads: [choice] }) });
      await vi.waitFor(() => expect(chat.received).toContainEqual({ type: "error", requestId: type, source: "session",
        message: expect.stringMatching(/review the deletion again/i) }));
    }
    expect(deleteThreads).not.toHaveBeenCalled();

    save(true);
    expect((await fetch(`${origin}/api/changes/status`)).status).toBe(200);
    expect((await fetch(`${origin}/api/changes/status`, { headers: { origin: "https://foreign.invalid" } })).status).toBe(403);
    const watcher = connect("?view=changes");
    const watcherClosed = once(watcher.ws, "close");
    await once(watcher.ws, "open");
    status = "loading";
    notifyStatus();
    await vi.waitFor(() => expect(watcher.received).toEqual([{ type: "changes.status", status: { kind: "loading" } }]));
    chat.send({ type: "thread.delete.preview", requestId: "old", threadIds: [a.threadId] });
    await vi.waitFor(() => expect(previewThreadDeletes).toHaveBeenCalledOnce());
    let finishDeleteReview = () => {};
    deleteThreads.mockImplementationOnce(async (_targets, ports) => {
      await new Promise<void>((resolve) => { finishDeleteReview = resolve; });
      ports.verifyCommit?.();
      throw new Error("Unexpected commit handoff");
    });
    chat.send({ type: "thread.delete", requestId: "in-flight-commit", threadId: a.threadId, mode: "commit" });
    await vi.waitFor(() => expect(deleteThreads).toHaveBeenCalledOnce());
    save(false);
    finishDeleteReview();
    await vi.waitFor(() => expect(chat.received).toContainEqual({ type: "error", requestId: "in-flight-commit",
      source: "session", message: "Review the deletion again." }));
    expect(store.get(a.threadId)).toBeDefined();
    expect(await watcherClosed).toEqual([1008, Buffer.from("Git source control preference changed")]);
    status = "none";
    notifyStatus();
    resolveReview([{ threadId: a.threadId, state: "complete", defaultMode: "commit", owned: true, willCommit: true, reason: "Private Git details" }]);
    await vi.waitFor(() => expect(chat.received).toContainEqual({ type: "thread.delete.preview", requestId: "old", threads: [
      { threadId: a.threadId, state: "none", defaultMode: "keep" },
    ] }));
    expect(chat.received.filter(({ type }) => type === "changes.status")).toEqual([{ type: "changes.status", status: { kind: "loading" } }]);

    chat.send({ type: "thread.delete", requestId: "one", threadId: a.threadId, mode: "keep" });
    await vi.waitFor(() => expect(chat.received).toContainEqual({ type: "thread.delete.done", requestId: "one" }));
    chat.send({ type: "threads.delete", requestId: "clear", threads: [{ threadId: b.threadId, mode: "keep" }] });
    await vi.waitFor(() => expect(chat.received).toContainEqual({ type: "thread.delete.done", requestId: "clear" }));
    chat.send({ type: "conversation.reset", requestId: "reset", threads: [{ threadId: c.threadId, mode: "keep" }] });
    await vi.waitFor(() => expect(chat.received).toContainEqual({ type: "conversation.reset.done", requestId: "reset" }));
    expect(deleteThreads.mock.calls.map(([targets]) => targets.map(({ mode }) => mode))).toEqual([["commit"], ["keep"], ["keep"], ["keep"]]);
    expect(store.list()).toEqual([]);
  } finally {
    for (const ws of sockets) ws.terminate();
    await server.close();
    resetThreadStore();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
