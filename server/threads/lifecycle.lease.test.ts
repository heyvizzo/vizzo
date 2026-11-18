import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ChangesService } from "../changes/changesService.ts";
import { LedgerWorkerClient } from "../changes/ledgerWorkerClient.ts";
import { WriterRegistry } from "../changes/writers.ts";
import { deleteThreads, flushThreadLifecycle, restoreThreadLifecycle } from "./lifecycle.ts";
import { loadThreads, writeThreads, type SavedThread } from "./persist.ts";
import { ThreadStore } from "./store.ts";

const anchor = {
  pageUrl: "https://example.invalid", selector: "body", domPath: "body", tag: "body",
  dataSource: null, label: null, text: null, role: null, bounds: { x: 0, y: 0, width: 1, height: 1 },
};

const legacy: SavedThread = {
  info: {
    threadId: "legacy", title: "Legacy", pageUrl: anchor.pageUrl, anchor, state: "idle", intent: "task",
    summary: "", messages: [], unread: false, awaitingReply: false, createdAt: 1, lastInteractionAt: 1,
  },
  projectFolder: null,
};

it.each(["files", "reftable"] as const)("keeps a pending delete out of a competing process's thread store (%s)", async (format) => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "vizzo-delete-lease-")));
  const repo = join(temporary, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Vizzo", "-c", "user.email=vizzo@example.invalid", ...args], { cwd: repo });
  git("init", "-q", "--template=", "-b", "main", `--ref-format=${format}`);
  writeFileSync(join(repo, "file.txt"), "base\n");
  git("add", "file.txt");
  git("commit", "-qm", "base");
  const journal = join(temporary, "settings", "ledger.json");
  const file = join(temporary, "settings", "threads.json");
  const pending: SavedThread = { ...legacy, info: { ...legacy.info, threadId: "closed", title: "Closed" }, projectFolder: repo };
  const clients = new Set<LedgerWorkerClient>();
  const connect = () => {
    const ledger = new LedgerWorkerClient(journal);
    clients.add(ledger);
    return { ledger, service: new ChangesService(ledger, new WriterRegistry(ledger)) };
  };
  try {
    const holder = connect();
    await holder.service.restore();
    const { project } = await holder.ledger.discover(repo);
    if (!project) throw new Error("Could not discover the test repository");
    writeThreads(file, [pending, legacy], true);
    await holder.ledger.handoffThreadDeletes([{ project, threadId: pending.info.threadId, title: pending.info.title, requests: [] }]);
    expect(await holder.ledger.pendingThreadDeletes()).toEqual([pending.info.threadId]);

    const contender = connect();
    const store = new ThreadStore();
    await restoreThreadLifecycle(file, contender.service, store);
    expect(store.list().map(({ threadId }) => threadId)).toEqual([legacy.info.threadId]);
    await deleteThreads(store, [{ threadId: legacy.info.threadId, mode: "keep" }], false);
    store.flush();
    expect(loadThreads(file)).toEqual([pending, legacy]);

    // The lease owner updates threads.json, then stops before acknowledging the durable removal in the ledger.
    const updated = { ...legacy, info: { ...legacy.info, title: "Updated by the lease owner" } };
    writeThreads(file, [updated], true);
    const ownerBytes = readFileSync(file);
    await flushThreadLifecycle({ flush: async () => {} }, store);
    expect(readFileSync(file)).toEqual(ownerBytes);

    await holder.ledger.close();
    clients.delete(holder.ledger);
    const recovered = connect();
    const saved = new ThreadStore();
    await restoreThreadLifecycle(file, recovered.service, saved);
    expect(saved.list()).toEqual([updated.info]);
    expect(loadThreads(file)).toEqual([updated]);
    expect(await recovered.ledger.pendingThreadDeletes()).toEqual([]);
  } finally {
    await Promise.allSettled([...clients].map((client) => client.close()));
    rmSync(temporary, { recursive: true, force: true });
  }
});
