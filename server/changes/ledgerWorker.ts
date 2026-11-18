import { parentPort, workerData } from "node:worker_threads";
import { LedgerCommitPinnedError, LedgerStore } from "./ledger.ts";
import { isLedgerLeaseRefused } from "./ledgerLease.ts";
import { LedgerPersistence } from "./persistence.ts";
import { discoverLedgerProject } from "./project.ts";
import type { LedgerNotification, LedgerRequest, LedgerResponse } from "./ledgerWorkerClient.ts";

if (!parentPort) throw new Error("The change ledger must run on a worker thread");
const port = parentPort;

function notify(projectId: string): void {
  port.postMessage({ changedProjectId: projectId } satisfies LedgerNotification);
}

const persistence: NonNullable<ConstructorParameters<typeof LedgerStore>[0]> = new LedgerPersistence(workerData?.file);
const store = new LedgerStore(persistence, notify);
let ready = false;
let expiry: ReturnType<typeof setTimeout> | undefined;
let queue = Promise.resolve();

function scheduleExpiry(deadline: number | undefined): void {
  clearTimeout(expiry);
  if (deadline === undefined) return;
  expiry = setTimeout(() => {
    queue = queue.then(() => {
      try { scheduleExpiry(store.pending().deadline); }
      catch (error) { console.warn("[changes] could not expire pending edits", error); }
    });
  }, Math.max(0, deadline - Date.now()));
  expiry.unref();
}

async function receive(request: LedgerRequest) {
  const { id } = request;
  try {
    if (!ready) {
      persistence.acquireLease();
      ready = true;
    }
    let result: unknown;
    let changedProject: string | undefined;
    let changedProjects: string[] = [];
    switch (request.method) {
      case "discover": result = discoverLedgerProject(request.directory); break;
      case "ingest": {
        const receipt = store.ingest(request.project, request.batch);
        result = receipt;
        if (!receipt.duplicate) changedProject = request.project.id;
        break;
      }
      case "observe": result = store.observe(request.project, request.paths); break;
      case "compact": result = store.compact(request.project, request.paths); break;
      case "pending": result = store.pending(); break;
      case "saveWriter":
        result = store.saveWriter(request.project, request.execution);
        changedProject = request.project.id;
        break;
      case "restoreWriters": result = await store.restoreWriters(); break;
      case "writerSnapshot": result = store.writerSnapshot(request.projectId); break;
      case "trackedPaths": result = store.trackedPaths(request.project); break;
      case "queueCommit":
        result = store.queueCommit(request.project, request.request);
        if (result) changedProject = request.project.id;
        break;
      case "threadDeleteContexts": result = store.threadDeleteContexts(request.targets); break;
      case "handoffThreadDeletes": {
        const handoff = store.handoffThreadDeletes(request.handoffs);
        result = handoff;
        changedProjects = handoff.projectIds;
        break;
      }
      case "pendingThreadDeletes": result = store.pendingThreadDeletes(); break;
      case "completeThreadDeletes": result = store.completeThreadDeletes(request.threadIds); break;
      case "closedThreads": result = store.closedThreads(request.project); break;
      case "carryThreadDeleteCommit":
        result = store.carryThreadDeleteCommit(request.key, request.expected, request.request);
        break;
      case "beginCommit":
        result = store.beginCommit(request.project, request.start);
        if (result) changedProject = request.project.id;
        break;
      case "pinCommit":
        result = store.pinCommit(request.key, request.frozen);
        changedProject = request.key.projectId;
        break;
      case "checkpointCommit": {
        const { record } = request;
        result = store.checkpointCommit(record, request.proof);
        if (record.phase === "done" || record.phase === "refused" || record.phase === "not-published" ||
            record.phase === "indeterminate" || (record.phase === "index-ready" && record.step === "repair")) {
          changedProject = record.project.id;
        }
        break;
      }
      case "commitJob": result = store.commitJob(request.key); break;
      case "commitJobs": result = store.commitJobs(request.projectId); break;
      case "checkpointRecovery": result = store.checkpointRecovery(request.key, request.checkpoint); break;
      case "finishRecovery":
        result = store.finishRecovery(request.key, request.outcome);
        changedProject = request.key.projectId;
        break;
      case "noteCommitIssue":
        result = store.noteCommitIssue(request.key, request.reason);
        changedProject = request.key.projectId;
        break;
    }
    if (request.method !== "discover") scheduleExpiry(store.pending().deadline);
    port.postMessage({ id, result } satisfies LedgerResponse);
    if (changedProject) notify(changedProject);
    for (const projectId of changedProjects) notify(projectId);
  } catch (error) {
    port.postMessage({
      id, error: error instanceof Error ? error.message : String(error),
      code: isLedgerLeaseRefused(error) ? error.code : error instanceof LedgerCommitPinnedError ? "LEDGER_COMMIT_PINNED" : undefined,
    } satisfies LedgerResponse);
  }
}

port.on("message", (request: LedgerRequest) => { queue = queue.then(() => receive(request)); });
