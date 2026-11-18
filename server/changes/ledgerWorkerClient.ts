import { Worker } from "node:worker_threads";
import type { EditBatch } from "./evidence.ts";
import type { BatchResult, LedgerStore, LedgerView } from "./ledger.ts";
import type { LedgerProject, ProjectDiscovery } from "./project.ts";

type Request =
  | { method: "discover"; directory: string }
  | { method: "ingest"; project: LedgerProject; batch: EditBatch }
  | { method: "observe" | "compact"; project: LedgerProject; paths: readonly string[] }
  | { method: "pending" };

export type LedgerRequest = Request & { id: number };
export type LedgerResponse = { id: number; result: unknown } | { id: number; error: string };

export class LedgerWorkerClient {
  private readonly worker: Worker;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private sequence = 0;
  private failure?: Error;

  constructor(file?: string) {
    const source = import.meta.url.endsWith(".ts") ? "./ledgerWorker.ts" : "./ledgerWorker.mjs";
    this.worker = new Worker(new URL(source, import.meta.url), { workerData: { file } });
    this.worker.on("message", (reply: LedgerResponse) => {
      const callbacks = this.waiting.get(reply.id);
      if (!callbacks) return;
      this.waiting.delete(reply.id);
      if (!this.waiting.size) this.worker.unref();
      if ("error" in reply) callbacks.reject(new Error(reply.error));
      else callbacks.resolve(reply.result);
    });
    const fail = (error: Error) => {
      this.failure = error;
      for (const request of this.waiting.values()) request.reject(error);
      this.waiting.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", (code) => fail(this.failure ?? new Error(`Change ledger worker exited (${code})`)));
    this.worker.unref();
  }

  private request<T>(request: Request): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.sequence++;
    return new Promise<T>((resolve, reject) => {
      this.worker.ref();
      this.waiting.set(id, { resolve: (result) => resolve(result as T), reject });
      try {
        this.worker.postMessage({ ...request, id } satisfies LedgerRequest);
      } catch (error) {
        this.waiting.delete(id);
        if (!this.waiting.size) this.worker.unref();
        reject(error);
      }
    });
  }

  discover(directory: string): Promise<ProjectDiscovery> {
    return this.request({ method: "discover", directory });
  }

  ingest(project: LedgerProject, batch: EditBatch): Promise<BatchResult> {
    return this.request({ method: "ingest", project, batch });
  }

  observe(project: LedgerProject, paths: readonly string[]): Promise<LedgerView> {
    return this.request({ method: "observe", project, paths });
  }

  compact(project: LedgerProject, paths: readonly string[]): Promise<void> {
    return this.request({ method: "compact", project, paths });
  }

  /** Also serves as a flush barrier for earlier requests, which are acknowledged after fsync. */
  pending(): Promise<ReturnType<LedgerStore["pending"]>> {
    return this.request({ method: "pending" });
  }

  async close(): Promise<void> {
    try { await this.pending(); }
    finally { await this.worker.terminate(); }
  }
}
