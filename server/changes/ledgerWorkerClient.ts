import { Worker } from "node:worker_threads";
import type { CommitOwnershipPlan, CommitOwnershipReceipt, PublishedBaseEvidence } from "./commitOwnership.ts";
import type { CommitRecoveryCheckpoint, CommitRecoveryResult } from "./commitRecovery.ts";
import type { CommitJournal, CommitRequest, CommitStart, FrozenCommitSelection } from "./commitTransaction.ts";
import type { EditBatch } from "./evidence.ts";
import type { BatchResult, CommitJobKey, CommitJobRecord, CommitJobSummary, LedgerStore, LedgerView } from "./ledger.ts";
import { isLedgerLeaseRefused, LedgerLeaseRefusedError } from "./ledgerLease.ts";
import type { LedgerProject, ProjectDiscovery } from "./project.ts";
import type { ProjectWriterSnapshot, WriterExecutionRecord } from "./writers.ts";

type Request =
  | { method: "discover"; directory: string }
  | { method: "ingest"; project: LedgerProject; batch: EditBatch }
  | { method: "observe" | "compact"; project: LedgerProject; paths: readonly string[] }
  | { method: "pending" | "restoreWriters" }
  | { method: "saveWriter"; project: LedgerProject; execution: WriterExecutionRecord }
  | { method: "writerSnapshot"; projectId: string }
  | { method: "trackedPaths"; project: LedgerProject }
  | { method: "queueCommit"; project: LedgerProject; request: CommitRequest }
  | { method: "beginCommit"; project: LedgerProject; start: CommitStart }
  | { method: "pinCommit"; key: CommitJobKey; frozen: FrozenCommitSelection<CommitOwnershipReceipt> }
  | { method: "checkpointCommit"; record: CommitJournal<CommitOwnershipPlan>; proof?: PublishedBaseEvidence }
  | { method: "commitJob"; key: CommitJobKey }
  | { method: "commitJobs"; projectId?: string }
  | { method: "checkpointRecovery"; key: CommitJobKey; checkpoint: CommitRecoveryCheckpoint }
  | { method: "finishRecovery"; key: CommitJobKey; outcome: Exclude<CommitRecoveryResult, { status: "skipped" }> }
  | { method: "noteCommitIssue"; key: CommitJobKey; reason: string };

export type LedgerRequest = Request & { id: number };
export type LedgerResponse = { id: number; result: unknown } | { id: number; error: string; code?: "LEDGER_LEASE_REFUSED" };
export type LedgerNotification = { changedProjectId: string };

export class LedgerWorkerClient {
  private readonly worker: Worker;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(projectId: string) => void>();
  private sequence = 0;
  private failure?: Error;

  constructor(file?: string) {
    const source = import.meta.url.endsWith(".ts") ? "./ledgerWorker.ts" : "./ledgerWorker.mjs";
    this.worker = new Worker(new URL(source, import.meta.url), { workerData: { file } });
    this.worker.on("message", (reply: LedgerResponse | LedgerNotification) => {
      if ("changedProjectId" in reply) {
        for (const listener of this.listeners) listener(reply.changedProjectId);
        return;
      }
      const callbacks = this.waiting.get(reply.id);
      if (!callbacks) return;
      this.waiting.delete(reply.id);
      if (!this.waiting.size) this.worker.unref();
      if ("error" in reply) callbacks.reject(reply.code === "LEDGER_LEASE_REFUSED"
        ? new LedgerLeaseRefusedError(reply.error) : new Error(reply.error));
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

  onChanged(listener: (projectId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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

  saveWriter(project: LedgerProject, execution: WriterExecutionRecord): Promise<void> {
    return this.request({ method: "saveWriter", project, execution });
  }

  restoreWriters(): Promise<void> {
    return this.request({ method: "restoreWriters" });
  }

  writerSnapshot(projectId: string): Promise<ProjectWriterSnapshot> {
    return this.request({ method: "writerSnapshot", projectId });
  }

  trackedPaths(project: LedgerProject): Promise<string[]> {
    return this.request({ method: "trackedPaths", project });
  }

  queueCommit(project: LedgerProject, request: CommitRequest): Promise<boolean> {
    return this.request({ method: "queueCommit", project, request });
  }

  beginCommit(project: LedgerProject, start: CommitStart): Promise<boolean> {
    return this.request({ method: "beginCommit", project, start });
  }

  pinCommit(key: CommitJobKey, frozen: FrozenCommitSelection<CommitOwnershipReceipt>): Promise<CommitOwnershipPlan> {
    return this.request({ method: "pinCommit", key, frozen });
  }

  checkpointCommit(record: CommitJournal<CommitOwnershipPlan>, proof?: PublishedBaseEvidence): Promise<void> {
    return this.request({ method: "checkpointCommit", record, proof });
  }

  commitJob(key: CommitJobKey): Promise<CommitJobRecord | null> {
    return this.request({ method: "commitJob", key });
  }

  commitJobs(projectId?: string): Promise<CommitJobSummary[]> {
    return this.request({ method: "commitJobs", projectId });
  }

  checkpointRecovery(key: CommitJobKey, checkpoint: CommitRecoveryCheckpoint): Promise<void> {
    return this.request({ method: "checkpointRecovery", key, checkpoint });
  }

  finishRecovery(key: CommitJobKey, outcome: Exclude<CommitRecoveryResult, { status: "skipped" }>): Promise<void> {
    return this.request({ method: "finishRecovery", key, outcome });
  }

  noteCommitIssue(key: CommitJobKey, reason: string): Promise<void> {
    return this.request({ method: "noteCommitIssue", key, reason });
  }

  /** Also serves as a flush barrier for earlier requests, which are acknowledged after fsync. */
  pending(): Promise<ReturnType<LedgerStore["pending"]>> {
    return this.request({ method: "pending" });
  }

  async close(): Promise<void> {
    try { await this.pending(); }
    catch (error) { if (!isLedgerLeaseRefused(error)) throw error; }
    finally { await this.worker.terminate(); }
  }
}

let shared: LedgerWorkerClient | undefined;
export function changesLedger(): LedgerWorkerClient { return shared ??= new LedgerWorkerClient(); }
