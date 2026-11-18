import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommitOwnershipPlan, CommitOwnershipReceipt, PublishedBaseEvidence } from "./commitOwnership.ts";
import { recoverCommit, type CommitRecoveryJournal, type CommitRecoveryPorts, type CommitRecoveryResult } from "./commitRecovery.ts";
import { runCommitTransaction, type CommitContext, type CommitJournal, type CommitRequest, type CommitResult,
  type FrozenCommitSelection } from "./commitTransaction.ts";
import { changeWriterId } from "./components.ts";
import { ThreadDeletes, type DeleteLedger, type ThreadDeletePorts, type ThreadDeleteTarget } from "./deleteFlows.ts";
import { ABSENT, type ReadEntry } from "./entries.ts";
import { MAX_FILE_BYTES } from "./evidence.ts";
import { GitPublicationError } from "./gitPublication.ts";
import type { GitEntryChange } from "./gitTree.ts";
import type { CommitJobKey, CommitJobRecord, CommitJobSummary } from "./ledger.ts";
import { changesLedger, type LedgerWorkerClient } from "./ledgerWorkerClient.ts";
import type { LedgerProject } from "./project.ts";
import { REVIEW_AGAIN, ScanRuntime, type ScanLedgerSource, type ScanWriterSource } from "./scanRuntime.ts";
import { writerRegistry, type WriterId, type WriterRegistry } from "./writers.ts";

export type CommitScan = (context: CommitContext) => Promise<FrozenCommitSelection<CommitOwnershipReceipt> | null>;
export type { ThreadDeletePorts, ThreadDeletePreview, ThreadDeleteTarget } from "./deleteFlows.ts";
export type ChangesUpdate =
  | { kind: "ledger"; projectId: string }
  | { kind: "scan"; projectId: string; generation: number; changedFiles: number };

type ServiceLedger = ScanLedgerSource & DeleteLedger & Pick<LedgerWorkerClient, "pending" | "queueCommit" | "beginCommit" | "pinCommit" |
  "checkpointCommit" | "commitJob" | "commitJobs" | "checkpointRecovery" | "finishRecovery" | "noteCommitIssue" | "onChanged">;
type ServiceWriters = Pick<WriterRegistry, "restore" | "reserve" | "flush" | "snapshot">;
type RecoveryJournal = CommitRecoveryJournal & { project: LedgerProject };

const execGit = promisify(execFile);
const busy = new Map<string, Promise<void>>();
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function assertCurrentScope(isCurrent?: () => boolean): (() => void) | undefined {
  return isCurrent && (() => {
    if (!isCurrent()) throw new GitPublicationError("stale-context", REVIEW_AGAIN);
  });
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function isTerminal(phase: CommitJobRecord["journal"]["phase"]): phase is "done" | "refused" | "not-published" {
  return phase === "done" || phase === "refused" || phase === "not-published";
}

function writerId(id: string): WriterId {
  const value: unknown = JSON.parse(id);
  if (Array.isArray(value) && value.length === 2 &&
      (value[0] === "thread" || value[0] === "central" || value[0] === "job") && typeof value[1] === "string") {
    const writer: WriterId = { kind: value[0], id: value[1] };
    if (changeWriterId(writer) === id) return writer;
  }
  throw new Error("Invalid commit writer");
}

async function serial<T>(project: LedgerProject, task: () => Promise<T>): Promise<T> {
  const result = (busy.get(project.commonDir) ?? Promise.resolve()).then(task);
  const barrier = result.then(() => {}, () => {});
  busy.set(project.commonDir, barrier);
  try { return await result; }
  finally {
    if (busy.get(project.commonDir) === barrier) busy.delete(project.commonDir);
  }
}

async function readGit(project: LedgerProject, args: string[], maxBuffer = MAX_FILE_BYTES): Promise<Buffer> {
  const { stdout } = await execGit("git", [
    "--no-pager", "--no-replace-objects", "--no-optional-locks", "--literal-pathspecs",
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    `--git-dir=${project.gitDir}`, `--work-tree=${project.root}`, ...args,
  ], {
    cwd: project.root, encoding: "buffer", maxBuffer, timeout: 10_000,
    env: {
      ...process.env, LC_ALL: "C", GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined,
      GIT_NAMESPACE: undefined, GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
      GIT_QUARANTINE_PATH: undefined, GIT_INDEX_FILE: undefined, GIT_ATTR_SOURCE: undefined, GIT_PREFIX: undefined,
      GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1",
    },
  });
  return stdout;
}

async function candidateEntry(
  project: LedgerProject, commit: string, { path, next }: GitEntryChange,
): Promise<PublishedBaseEvidence["paths"][number]> {
  const actual = await readGit(project, ["ls-tree", "-z", "--full-tree", commit, "--", path]);
  const expected = Buffer.from(next ? `${next.mode} blob ${next.oid}\t${path}\0` : "");
  if (!actual.equals(expected)) throw new Error(`Git's candidate entry changed for ${JSON.stringify(path)}`);
  if (!next) return { path, raw: null, working: ABSENT };

  const raw = await readGit(project, ["cat-file", "blob", next.oid]);
  const working: ReadEntry = next.mode === "120000" ? { kind: "symlink", bytes: raw } : {
    kind: "file", mode: next.mode,
    bytes: await readGit(project, [`--attr-source=${commit}`, "cat-file", "--filters", `--path=${path}`, next.oid]),
  };
  return { path, raw, working };
}

/** Read the exact candidate, independently of the real index, current HEAD and working-tree attributes. */
async function prepareBase(
  project: LedgerProject, record: Extract<CommitJournal<CommitOwnershipPlan>, { phase: "publishing" }>,
): Promise<PublishedBaseEvidence> {
  if (!OID.test(record.commit) || (await readGit(project, ["cat-file", "-t", record.commit])).toString() !== "commit\n") {
    throw new Error("Git did not retain the candidate commit");
  }
  const paths: PublishedBaseEvidence["paths"][number][] = [];
  for (const entry of record.entries) paths.push(await candidateEntry(project, record.commit, entry));
  return { commit: record.commit, paths };
}

/** Server-internal commit and recovery API. Scans are supplied by the scoped review that owns the generation. */
export class ChangesService {
  private startup?: Promise<void>;
  private readonly listeners = new Set<(update: ChangesUpdate) => void>();
  private readonly threadDeletes: ThreadDeletes;
  readonly scanner: ScanRuntime;

  constructor(private readonly ledger: ServiceLedger = changesLedger(), private readonly writers: ServiceWriters = writerRegistry()) {
    this.scanner = new ScanRuntime({
      ledger, writers,
      groupState: (project) => this.threadDeletes.groupState(project),
      updated: ({ project, generation, changedFiles }) => this.publish({ kind: "scan", projectId: project, generation, changedFiles }),
    });
    this.threadDeletes = new ThreadDeletes({
      ledger, writers, scanner: this.scanner,
      inRepository: serial,
      commit: (project, request, scanAndFreeze) => this.commitInRepository(project, request, scanAndFreeze),
    });
    ledger.onChanged((projectId) => {
      this.scanner.ledgerChanged(projectId);
      this.publish({ kind: "ledger", projectId });
    });
  }

  subscribe(listener: (update: ChangesUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(update: ChangesUpdate): void {
    for (const listener of this.listeners) {
      try { listener(update); }
      catch (error) { console.warn("[changes] source-control listener failed", error); }
    }
  }

  restore(): Promise<void> {
    return this.startup ??= this.restoreJobs();
  }

  private async restoreJobs(): Promise<void> {
    await this.writers.restore();
    for (const job of await this.ledger.commitJobs()) {
      if (isTerminal(job.phase)) continue;
      try {
        await this.restoreJob(job);
      } catch (error) {
        console.warn(`[changes] could not recover commit ${job.jobId}`, error);
      }
    }
  }

  private async reportIssue(key: CommitJobKey, reason: string): Promise<void> {
    try {
      if (await this.ledger.commitJob(key)) await this.ledger.noteCommitIssue(key, reason);
    } catch (error) {
      console.warn(`[changes] could not update commit ${key.jobId}`, error);
    }
  }

  private restoreJob(summary: CommitJobSummary, isCurrent?: () => boolean): Promise<CommitRecoveryResult> {
    const { project, jobId } = summary;
    const key = { projectId: project.id, jobId };
    return serial(project, async () => {
      if (isCurrent && !isCurrent()) return { status: "skipped", reason: "missing-job" };
      const job = await this.ledger.commitJob(key);
      if (isCurrent && !isCurrent()) return { status: "skipped", reason: "missing-job" };
      if (!job) return { status: "skipped", reason: "missing-job" };
      if (isTerminal(job.journal.phase)) return { status: "skipped", phase: job.journal.phase };
      if (job.journal.phase === "queued") {
        const result = {
          status: "refused", evidence: "not-attempted",
          refusal: { code: "interrupted", reason: "Vizzo stopped before starting the queued commit." },
        } as const;
        await this.ledger.finishRecovery(key, result);
        return result;
      }

      let finished = false;
      const ports: CommitRecoveryPorts<RecoveryJournal> = {
        reload: async () => {
          const current = await this.ledger.commitJob(key);
          if (isCurrent && !isCurrent()) return null;
          if (!current || current.journal.phase === "queued") return null;
          return { ...current.journal, project: current.project, recovery: current.recovery };
        },
        checkpoint: (_job, checkpoint) => this.ledger.checkpointRecovery(key, checkpoint),
        assertInstallContext: assertCurrentScope(isCurrent),
        finish: async (_job, outcome) => {
          await this.ledger.finishRecovery(key, outcome);
          finished = true;
        },
      };
      try {
        const result = await recoverCommit({ project: job.project, request: job.journal.request }, ports);
        if (!finished && result.status === "blocked") await this.ledger.finishRecovery(key, result);
        return result;
      } catch (error) {
        if (error instanceof GitPublicationError && error.code === "stale-context") return { status: "skipped", reason: "missing-job" };
        await this.reportIssue(key, `Vizzo could not finish commit recovery. ${message(error)}`);
        throw error;
      }
    });
  }

  private async verifyProject(project: LedgerProject): Promise<LedgerProject> {
    const discovered = await this.ledger.discover(project.servedDir);
    const actual = discovered.project;
    if (!actual) throw new Error(discovered.reason);
    if (actual.id !== project.id || actual.root !== project.root || actual.gitDir !== project.gitDir ||
        actual.commonDir !== project.commonDir || actual.scope !== project.scope || actual.servedDir !== project.servedDir) {
      throw new Error("The pinned source-control project changed");
    }
    return actual;
  }

  async enqueue(project: LedgerProject, request: CommitRequest): Promise<boolean> {
    await this.restore();
    return this.ledger.queueCommit(await this.verifyProject(project), request);
  }

  async commit(project: LedgerProject, request: CommitRequest, scanAndFreeze: CommitScan, isCurrent?: () => boolean): Promise<CommitResult> {
    await this.restore();
    return serial(project, () => this.commitInRepository(project, request, scanAndFreeze, isCurrent));
  }

  private async commitInRepository(project: LedgerProject, request: CommitRequest, scanAndFreeze: CommitScan,
    isCurrent?: () => boolean): Promise<CommitResult> {
    const key = { projectId: project.id, jobId: request.jobId };
    if (isCurrent && !isCurrent()) return { status: "refused", code: "stale", reason: REVIEW_AGAIN };
    const pinned = await this.verifyProject(project);
    const blocker = (await this.ledger.commitJobs()).find((job) =>
      job.project.commonDir === pinned.commonDir && job.phase !== "queued" && !isTerminal(job.phase));
    if (blocker) return {
      status: "refused", code: blocker.project.id === project.id && blocker.jobId === request.jobId
        ? "duplicate-job" : "recovery-needed",
      reason: blocker.reason ?? "Vizzo must recover an unfinished source-control commit first",
    };
    return runCommitTransaction<CommitOwnershipPlan>(pinned, request, {
      begin: (start) => this.ledger.beginCommit(pinned, start),
      journal: async (record) => {
        const proof = record.phase === "publishing" && record.step === "prepare-ref"
          ? await prepareBase(pinned, record) : undefined;
        await this.ledger.checkpointCommit(record, proof);
      },
      reserveWriters: async () => this.writers.reserve(pinned.id, request.writerIds.map(writerId)),
      scanAndFreeze: async (context) => {
        const frozen = await scanAndFreeze(context);
        if (!frozen) return null;
        const ownership = await this.ledger.pinCommit(key, frozen);
        return { ...frozen, ownership };
      },
      assertPublicationContext: assertCurrentScope(isCurrent),
      settle: (record) => this.ledger.checkpointCommit(record),
    }).catch(async (error) => {
      await this.reportIssue(key, `Vizzo could not finish the commit. ${message(error)}`);
      throw error;
    });
  }

  async previewThreadDeletes(targets: readonly ThreadDeleteTarget[]) {
    await this.restore();
    return this.threadDeletes.preview(targets);
  }

  async deleteThreads(targets: readonly ThreadDeleteTarget[], ports: ThreadDeletePorts) {
    await this.restore();
    return this.threadDeletes.delete(targets, ports);
  }

  async pendingThreadDeletes(): Promise<string[]> {
    await this.restore();
    return this.ledger.pendingThreadDeletes();
  }

  async completeThreadDeletes(threadIds: readonly string[]): Promise<void> {
    await this.restore();
    await this.ledger.completeThreadDeletes(threadIds);
  }

  /** Available independently of the scanner, including after restart or while Git needs repair. */
  async jobs(projectId?: string): Promise<CommitJobSummary[]> {
    await this.restore();
    return this.ledger.commitJobs(projectId);
  }

  writerSnapshot(projectId: string): ReturnType<ScanWriterSource["snapshot"]> {
    return this.writers.snapshot(projectId);
  }

  async fix(projectId: string, jobId: string, isCurrent?: () => boolean): Promise<CommitRecoveryResult> {
    await this.restore();
    const summary = (await this.ledger.commitJobs(projectId)).find((job) => job.jobId === jobId && job.phase !== "queued");
    return summary && (!isCurrent || summary.canFix) ? this.restoreJob(summary, isCurrent) : { status: "skipped", reason: "missing-job" };
  }

  async flush(): Promise<void> {
    await this.writers.flush();
    await this.ledger.pending();
  }
}

let shared: ChangesService | undefined;
export function changesService(): ChangesService { return shared ??= new ChangesService(); }
