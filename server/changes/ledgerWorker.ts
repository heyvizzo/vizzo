import { parentPort, workerData } from "node:worker_threads";
import { LedgerStore } from "./ledger.ts";
import { LedgerPersistence } from "./persistence.ts";
import { discoverLedgerProject } from "./project.ts";
import type { LedgerRequest, LedgerResponse } from "./ledgerWorkerClient.ts";

if (!parentPort) throw new Error("The change ledger must run on a worker thread");
const port = parentPort;

const store = new LedgerStore(new LedgerPersistence(workerData?.file));
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
    let result: unknown;
    switch (request.method) {
      case "discover": result = discoverLedgerProject(request.directory); break;
      case "ingest": result = store.ingest(request.project, request.batch); break;
      case "observe": result = store.observe(request.project, request.paths); break;
      case "compact": result = store.compact(request.project, request.paths); break;
      case "pending": result = store.pending(); break;
      case "saveWriter": result = store.saveWriter(request.project, request.execution); break;
      case "restoreWriters": result = await store.restoreWriters(); break;
      case "writerSnapshot": result = store.writerSnapshot(request.projectId); break;
      case "trackedPaths": result = store.trackedPaths(request.project); break;
      case "queueCommit": result = store.queueCommit(request.project, request.request); break;
      case "beginCommit": result = store.beginCommit(request.project, request.start); break;
      case "pinCommit": result = store.pinCommit(request.key, request.frozen); break;
      case "checkpointCommit": result = store.checkpointCommit(request.record, request.proof); break;
      case "commitJob": result = store.commitJob(request.key); break;
      case "commitJobs": result = store.commitJobs(request.projectId); break;
      case "checkpointRecovery": result = store.checkpointRecovery(request.key, request.checkpoint); break;
      case "finishRecovery": result = store.finishRecovery(request.key, request.outcome); break;
    }
    if (request.method !== "discover") scheduleExpiry(store.pending().deadline);
    port.postMessage({ id, result } satisfies LedgerResponse);
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies LedgerResponse);
  }
}

port.on("message", (request: LedgerRequest) => { queue = queue.then(() => receive(request)); });
