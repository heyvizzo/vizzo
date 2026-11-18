import { parentPort, workerData } from "node:worker_threads";
import { LedgerStore } from "./ledger.ts";
import { LedgerPersistence } from "./persistence.ts";
import { discoverLedgerProject } from "./project.ts";
import type { LedgerRequest, LedgerResponse } from "./ledgerWorkerClient.ts";

const port = parentPort;
if (!port) throw new Error("The change ledger must run on a worker thread");

const store = new LedgerStore(new LedgerPersistence(workerData?.file));
let expiry: ReturnType<typeof setTimeout> | undefined;

function scheduleExpiry(deadline: number | undefined): void {
  clearTimeout(expiry);
  if (deadline === undefined) return;
  expiry = setTimeout(() => {
    try { scheduleExpiry(store.pending().deadline); }
    catch (error) { console.warn("[changes] could not expire pending edits", error); }
  }, Math.max(0, deadline - Date.now()));
  expiry.unref();
}

port.on("message", (request: LedgerRequest) => {
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
      case "restoreWriters": result = store.restoreWriters(); break;
      case "writerSnapshot": result = store.writerSnapshot(request.projectId); break;
    }
    if (request.method !== "discover") scheduleExpiry(store.pending().deadline);
    port.postMessage({ id, result } satisfies LedgerResponse);
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies LedgerResponse);
  }
});
