import { randomUUID } from "node:crypto";
import type { LlmProvider } from "../../shared/config.ts";
import type { NativeProcessIdentity } from "../adapters/nativeProcess.ts";
import type { EditChange } from "./evidence.ts";
import { isLedgerLeaseRefused } from "./ledgerLease.ts";
import { changesLedger, type LedgerWorkerClient } from "./ledgerWorkerClient.ts";
import type { LedgerProject, ProjectDiscovery } from "./project.ts";

export interface WriterId {
  kind: "thread" | "central" | "job";
  id: string;
}

export type ExecutionOutcome = "completed" | "stopped" | "failed" | "timed-out" | "interrupted";
export type ExecutionPhase = "queued" | "running" | "settling" | "unconfirmed" | "settled";

export interface WriterDispatch {
  writer: WriterId;
  title: string;
  request: string;
  folder: string | null;
  harness?: LlmProvider;
  purpose: "request" | "followup" | "correction" | "reconcile" | "direct";
  continuesExecutionId?: string;
}

export interface WriterExecutionRecord extends WriterDispatch {
  executionId: string;
  phase: ExecutionPhase;
  outcome?: ExecutionOutcome;
  reason?: string;
  /** False is the durable pre-dispatch gate. Missing means an older journal did not keep this evidence. */
  nativeDispatched?: boolean;
  requiresNativeConfirmation?: boolean;
  nativeProcess?: NativeProcessIdentity;
  nativeSessionId?: string;
}

export interface ProjectWriterSnapshot {
  projectId: string;
  executions: (Omit<WriterExecutionRecord, "nativeProcess"> & { projectId: string; pending: boolean })[];
}

type WriterLedger = Pick<LedgerWorkerClient, "discover" | "saveWriter" | "restoreWriters" | "writerSnapshot" | "ingest" | "pending">;

const keyOf = ({ kind, id }: WriterId) => JSON.stringify([kind, id]);

function deferred() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
}

function outcomeOf(error: unknown): ExecutionOutcome {
  if (!(error instanceof Error)) return "failed";
  if (error.name === "AbortError") return "stopped";
  if (error.name === "TimeoutError" || /timed out|time limit/i.test(error.message)) return "timed-out";
  return "failed";
}

export class WriterRegistry {
  private worker?: WriterLedger;
  private boot?: Promise<void>;
  private failure?: unknown;
  private readonly writes = new Set<Promise<unknown>>();
  private readonly locks = new Map<string, Set<ReturnType<typeof deferred>>>();

  constructor(worker?: WriterLedger) { this.worker = worker; }

  private ledger(): WriterLedger {
    return this.worker ??= changesLedger();
  }

  /** Recover registered executions from the previous voice process before taking new ones. */
  restore(): Promise<void> {
    return this.boot ??= this.ledger().restoreWriters();
  }

  async project(folder: string): Promise<ProjectDiscovery> {
    try { await this.restore(); }
    catch (error) {
      // A voice process that never opened the journal can run solvers without registering them.
      if (isLedgerLeaseRefused(error)) return { reason: error.message };
      throw error;
    }
    return this.ledger().discover(folder);
  }

  track<T>(write: Promise<T>): Promise<T> {
    this.writes.add(write);
    void write.then(() => this.writes.delete(write), (error) => {
      this.writes.delete(write);
      if (!this.failure) console.warn("[changes] writer ledger unavailable", error);
      this.failure ??= error;
    });
    return write;
  }

  queue(spec: WriterDispatch, requiredSessionId?: string): WriterExecution {
    return new WriterExecution(this, spec, requiredSessionId);
  }

  save(project: LedgerProject, execution: WriterExecutionRecord): Promise<void> {
    return this.ledger().saveWriter(project, execution);
  }

  evidence(project: LedgerProject, executionId: string, sessionId: string, toolCallId: string, changes: EditChange[]) {
    return this.ledger().ingest(project, { executionId, sessionId, toolCallId, outcome: "completed", changes });
  }

  /** A transaction reserves the writers' next dispatch. Existing executions continue to count as working. */
  reserve(projectId: string, writers: readonly WriterId[]): () => void {
    const keys = [...new Set(writers.map((writer) => JSON.stringify([projectId, keyOf(writer)])))];
    const lock = deferred();
    for (const key of keys) {
      const reservations = this.locks.get(key) ?? new Set();
      reservations.add(lock);
      this.locks.set(key, reservations);
    }
    return () => {
      for (const key of keys) {
        const reservations = this.locks.get(key);
        reservations?.delete(lock);
        if (!reservations?.size) this.locks.delete(key);
      }
      lock.release();
    };
  }

  reservation(projectId: string, writer: WriterId): Promise<unknown> | undefined {
    const locks = this.locks.get(JSON.stringify([projectId, keyOf(writer)]));
    if (locks?.size) return Promise.all([...locks].map((lock) => lock.ready));
  }

  async snapshot(projectId: string): Promise<ProjectWriterSnapshot> {
    await this.restore();
    await this.flush();
    return this.ledger().writerSnapshot(projectId);
  }

  async flush(): Promise<void> {
    while (this.writes.size) await Promise.allSettled([...this.writes]);
    if (this.failure) throw this.failure;
    if (this.worker) await this.worker.pending();
  }
}

export class WriterExecution {
  private readonly record: WriterExecutionRecord;
  private readonly registry: WriterRegistry;
  private readonly discovery?: Promise<ProjectDiscovery>;
  private serial: Promise<unknown> = Promise.resolve();
  private settlement: Promise<void> = Promise.resolve();
  private stopOutcome?: ExecutionOutcome;
  private readonly cancelled = deferred();
  private readonly settledSignal = deferred();
  private started = false;
  private finishing = false;

  constructor(registry: WriterRegistry, spec: WriterDispatch, readonly requiredSessionId?: string) {
    this.registry = registry;
    this.record = { ...spec, writer: { ...spec.writer }, executionId: randomUUID(), phase: "queued", nativeDispatched: false };
    if (spec.folder) this.discovery = registry.track(registry.project(spec.folder));
    this.save();
  }

  get id(): string { return this.record.executionId; }
  get folder(): string | null { return this.record.folder; }
  get stopRequested(): boolean { return this.stopOutcome !== undefined; }
  get writer(): WriterId { return { ...this.record.writer }; }
  get settled(): Promise<void> { return this.settledSignal.ready; }

  private schedule(write: (project: LedgerProject) => Promise<unknown>): void {
    if (!this.discovery) return;
    const previous = this.serial;
    this.serial = this.registry.track((async () => {
      await previous;
      const { project } = await this.discovery!;
      if (project) await write(project);
    })());
    // A ledger fault blocks scope-based selection, while the solver's existing features keep working.
    void this.serial.catch(() => {});
  }

  private save(): void {
    const record = { ...this.record };
    this.schedule((project) => this.registry.save(project, record));
  }

  handoff(jobId: string, title: string): void {
    if (this.record.writer.kind !== "central") throw new Error("Only a central execution can be handed to a job");
    this.record.writer = { kind: "job", id: jobId };
    this.record.title = title;
    this.save();
  }

  /** Called synchronously by the harness stream before it reports settlement. */
  edits(sessionId: string, toolCallId: string, changes: EditChange[]): void {
    if (this.record.phase === "settled") return;
    this.observeNativeSession(sessionId);
    this.schedule((project) => this.registry.evidence(project, this.id, sessionId, toolCallId, changes));
  }

  observeNativeSession(sessionId: string | undefined): void {
    if (!sessionId || this.record.phase === "settled" || this.record.nativeSessionId === sessionId) return;
    this.record.nativeSessionId = sessionId;
    this.save();
  }

  async bindNative(identity: NativeProcessIdentity, requiresNativeConfirmation = false): Promise<void> {
    this.record.nativeProcess = identity;
    this.record.nativeDispatched = true;
    this.record.requiresNativeConfirmation = requiresNativeConfirmation;
    this.save();
    await this.serial;
  }

  waitForSettlement(barrier: Promise<void>): void {
    this.settlement = Promise.all([this.settlement, barrier]).then(() => {});
  }

  stopping(outcome: ExecutionOutcome = "stopped"): void {
    if (this.record.phase === "settled") return;
    if (outcome === "interrupted") this.stopOutcome = outcome;
    else this.stopOutcome ??= outcome;
    if (this.record.phase === "queued" || this.record.phase === "running") {
      this.record.phase = "settling";
      this.save();
    } else if (outcome === "interrupted" && this.record.outcome !== outcome) {
      this.record.outcome = outcome;
      this.save();
    }
    this.cancelled.release();
  }

  unconfirmed(reason = "The harness has not confirmed it stopped"): void {
    if (this.record.phase === "settled") return;
    this.record.phase = "unconfirmed";
    this.record.reason = reason;
    this.save();
  }

  cancelQueued(): void {
    this.stopping();
    if (!this.started) this.finish("stopped");
  }

  run<T>(dispatch: () => Promise<T>): Promise<T> {
    if (this.started) return Promise.reject(new Error("Execution already dispatched"));
    this.started = true;
    const assertActive = (): void => {
      if (this.stopOutcome) throw Object.assign(new Error("Solver request stopped before dispatch"), { name: "AbortError" });
    };
    const enter = (): void => {
      assertActive();
      this.record.phase = "running";
      this.save();
    };
    const start = async (): Promise<T> => {
      if (!this.discovery) {
        enter();
        return dispatch();
      }
      const project = await this.discovery?.then((result) => result.project).catch(() => undefined);
      if (project) {
        for (let reservation = this.registry.reservation(project.id, this.record.writer); reservation;
          reservation = this.registry.reservation(project.id, this.record.writer)) {
          await Promise.race([reservation, this.cancelled.ready]);
          if (this.stopOutcome) break;
        }
      }
      enter();
      await this.serial.catch(() => {});
      assertActive();
      return dispatch();
    };
    return start().then((result) => {
      this.finish(this.stopOutcome ?? "completed");
      return result;
    }, (error) => {
      this.finish(this.stopOutcome ?? outcomeOf(error));
      throw error;
    });
  }

  private finish(outcome: ExecutionOutcome): void {
    if (this.finishing) return;
    this.finishing = true;
    if (this.record.phase !== "unconfirmed") this.record.phase = "settling";
    this.record.outcome = outcome;
    this.save();
    void this.settlement.then(async () => {
      await this.serial.catch(() => {});
      this.record.phase = "settled";
      delete this.record.nativeProcess;
      delete this.record.reason;
      this.record.outcome = this.stopOutcome ?? outcome;
      this.save();
      await this.serial.catch(() => {});
      this.settledSignal.release();
    }, () => this.unconfirmed());
  }
}

let shared: WriterRegistry | undefined;
export function writerRegistry(): WriterRegistry { return shared ??= new WriterRegistry(); }
