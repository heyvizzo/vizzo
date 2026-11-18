import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadAnchor } from "../../shared/threads.ts";
import { setProjectDir } from "../project.ts";
import { deleteThreads, flushThreadLifecycle, previewThreadDeletes, restoreThreadLifecycle } from "./lifecycle.ts";
import { loadThreads } from "./persist.ts";
import { ThreadStore } from "./store.ts";

const anchor: ThreadAnchor = {
  pageUrl: "http://localhost/", selector: "button", domPath: "body > button", tag: "button",
  text: null, role: null, label: null, dataSource: null, bounds: { x: 0, y: 0, width: 16, height: 16 },
};
type DeleteService = NonNullable<Parameters<typeof deleteThreads>[3]>;

let directory: string;
let file: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "vizzo-thread-delete-"));
  file = join(directory, "threads.json");
});
afterEach(() => {
  setProjectDir(null);
  rmSync(directory, { force: true, recursive: true });
});

describe("deleting and restoring threads", () => {
  it("preflights every pinned folder before reset and holds removal behind each stop", async () => {
    const oldProject = join(directory, "old");
    const nextProject = join(directory, "next");
    mkdirSync(oldProject);
    mkdirSync(nextProject);
    const store = new ThreadStore();
    store.persistTo(file);
    setProjectDir(oldProject);
    const a = store.create(anchor, "old thread", "task");
    setProjectDir(nextProject);
    const b = store.create(anchor, "new thread", "task");
    const closed = vi.fn();
    let finishStop!: () => void;
    const settled = new Promise<void>((resolve) => { finishStop = resolve; });
    const stopped = vi.fn(() => settled);
    store.get(b.threadId)!.run = { stop: closed, stopForDeletion: stopped, working: true };
    const prepareReset = vi.spyOn(store, "prepareReset");
    const clear = vi.spyOn(store, "clearConversation");
    const choices = [{ threadId: a.threadId, mode: "commit" as const }];
    const service: DeleteService = {
      previewThreadDeletes: vi.fn(),
      deleteThreads: vi.fn<DeleteService["deleteThreads"]>(async (targets, _ports) => {
        expect(targets.map(({ folder, mode }) => ({ folder, mode }))).toEqual([
          { folder: oldProject, mode: "commit" }, { folder: nextProject, mode: "keep" },
        ]);
        throw new Error("Review the other project again");
      }),
    };
    await expect(deleteThreads(store, choices, true, service)).rejects.toThrow("Review the other project again");
    expect(prepareReset).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(store.list()).toHaveLength(2);

    service.deleteThreads = vi.fn<DeleteService["deleteThreads"]>(async (targets, ports) => {
      await ports.prepare?.();
      await ports.stop(b.threadId);
      await ports.remove(targets.map(({ threadId }) => threadId));
      expect(loadThreads(file)).toEqual([]);
      return [];
    });
    const deletion = deleteThreads(store, choices, true, service);
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce());
    expect(prepareReset).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
    expect(store.blocksRun(a.threadId)).toBe(true);
    await expect(deleteThreads(store, choices, false, service)).rejects.toThrow("still in progress");
    finishStop();
    await deletion;
    await deleteThreads(store, choices, false, service); // a retry sees no live thread
    expect(service.deleteThreads).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    store.flush();
  });

  it("keeps a failed handoff blocked and finishes it before restoring threads at startup", async () => {
    const original = new ThreadStore();
    original.persistTo(file);
    const closed = original.create(anchor, "closed", "task").threadId;
    const live = original.create(anchor, "live", "task").threadId;
    original.flush();
    const backup = join(directory, "saved.json");
    renameSync(file, backup);
    mkdirSync(file); // the atomic rename cannot replace this directory
    expect(() => original.removeDurably([closed])).toThrow();
    expect(original.blocksRun(closed)).toBe(true);
    expect(original.info(closed)).toBeDefined();

    const completeThreadDeletes = vi.fn(async () => {
      expect(loadThreads(file).map(({ info }) => info.threadId)).toEqual([live]);
    });
    const service = { restore: vi.fn(async () => {}), pendingThreadDeletes: vi.fn(async () => [closed]), completeThreadDeletes };
    const restarted = new ThreadStore();
    await expect(restoreThreadLifecycle(file, service, restarted)).rejects.toThrow();
    expect(restarted.list()).toEqual([]);
    expect(completeThreadDeletes).not.toHaveBeenCalled();

    rmSync(file, { recursive: true });
    renameSync(backup, file);
    await restoreThreadLifecycle(file, service, restarted);
    expect(restarted.info(closed)).toBeUndefined();
    expect(restarted.get(live)).toMatchObject({ handle: null });
    expect(completeThreadDeletes).toHaveBeenCalledWith([closed]);
  });

  it.each(["restore", "pendingThreadDeletes"] as const)("retains saved nonrepository threads when %s is unavailable", async (fail) => {
    const first = new ThreadStore();
    first.persistTo(file);
    setProjectDir(directory);
    const saved = first.create(anchor, "saved", "task");
    first.flush();
    const startup = { restore: vi.fn(async () => {}), pendingThreadDeletes: vi.fn(async () => []), completeThreadDeletes: vi.fn() };
    startup[fail].mockRejectedValueOnce(new Error("Ledger unavailable"));
    const store = new ThreadStore();
    await restoreThreadLifecycle(file, startup, store);
    expect(store.info(saved.threadId)).toBeDefined();
    const service = { previewThreadDeletes: vi.fn(), deleteThreads: vi.fn() };
    expect(await previewThreadDeletes(store, [saved.threadId], service)).toMatchObject([{ state: "none", defaultMode: "keep" }]);
    await deleteThreads(store, [{ threadId: saved.threadId, mode: "commit" }], false, service);
    expect(service.previewThreadDeletes).not.toHaveBeenCalled();
    expect(service.deleteThreads).not.toHaveBeenCalled();
    expect(loadThreads(file)).toEqual([]);
    store.flush();
  });

  it("keeps the quit handshake open until the source-control flush completes", async () => {
    const store = new ThreadStore();
    store.persistTo(file);
    const thread = store.create(anchor, "quit", "task");
    store.update(thread.threadId, (info) => { info.state = "running"; });
    let release!: () => void;
    const service = { flush: vi.fn(() => new Promise<void>((done) => { release = done; })) };
    const flushed = vi.fn();
    const handshake = flushThreadLifecycle(service, store).then(flushed);
    await vi.waitFor(() => expect(service.flush).toHaveBeenCalledOnce());
    expect(loadThreads(file)[0]?.info.state).toBe("running");
    expect(store.turnsBlocked).toBe(true);
    expect(flushed).not.toHaveBeenCalled();
    release();
    await handshake;
    expect(flushed).toHaveBeenCalledOnce();
  });
});
