import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import {
  acquireIndexLock, captureGitHead, classifyGitPublication, GitPublicationError, gitIndexPath,
  prepareGitRefVerify, reopenIndexLock,
  type GitHead, type IndexLock, type IndexLockIdentity, type JournaledIndexLock, type PublicationEvidence,
} from "./gitPublication.ts";
import { prepareIndexBytes, type GitEntryChange, type GitTreeEntry } from "./gitTree.ts";

interface RecoveryJob {
  readonly project: { readonly root: string; readonly commonDir: string };
  readonly request: { readonly jobId: string };
  readonly pid: number;
  readonly recovery?: CommitRecoveryCheckpoint | null;
}

interface RecoveryCandidate extends RecoveryJob {
  readonly indexPath: string;
  readonly lock: IndexLockIdentity;
  readonly head: Readonly<GitHead>;
  readonly commit: string;
  readonly entries: readonly GitEntryChange[];
}

type SkipPhase = "done" | "refused" | "not-published";

export type CommitRepairJournal = RecoveryCandidate & (
  | { readonly phase: "publishing"; readonly step?: "prepare-ref" | "prepare-index" | "write-index" }
  | { readonly phase: "index-ready"; readonly step?: "publish" | "classify" | "install" | "repair" | "release" }
  | { readonly phase: "indeterminate" }
);

type Refusal = { readonly code: string; readonly reason: string };

/** Structural subset of a transaction journal. The integrator retains the remaining fields, including ownership. */
export type CommitRecoveryJournal = CommitRepairJournal
  | (RecoveryCandidate & { readonly phase: "publishing"; readonly step: "cleanup"; readonly refusal: Refusal })
  | (RecoveryJob & {
    readonly phase: "locking";
    readonly indexPath?: string;
    readonly lock?: IndexLockIdentity;
    readonly refusal?: Refusal;
  })
  | (RecoveryJob & { readonly phase: SkipPhase });

export type CommitRecoveryCheckpoint =
  | { readonly step: "acquire-index" }
  | { readonly step: "inspect-index" | "cleanup"; readonly owner: JournaledIndexLock; readonly reusable: boolean }
  | { readonly step: "write-index"; readonly owner: JournaledIndexLock; readonly reusable: false }
  | { readonly step: "install-index"; readonly owner: JournaledIndexLock; readonly reusable: true };

type UnverifiedEvidence = "not-attempted" | "unverified";
type RepairReason = "branch-switched" | "branch-tip-changed" | "index-changed" | "index-error";

type FinishedRecovery =
  | { status: "refused"; evidence: "not-attempted"; refusal: Refusal }
  | { status: "not-published" | "indeterminate"; evidence: "not-published" | "indeterminate"; commit: string; message: string }
  | { status: "done"; evidence: "published"; commit: string; index: "already-current" | "reused" | "rebuilt" }
  | { status: "repair-needed"; evidence: "published"; commit: string; reason: RepairReason; canFix: boolean; message: string }
  | { status: "blocked"; evidence: PublicationEvidence | UnverifiedEvidence; reason: "repository-changed"; message: string }
  | { status: "blocked"; evidence: PublicationEvidence | UnverifiedEvidence; reason: "publication-busy"; canFix: true; message: string }
  | {
    status: "blocked"; evidence: PublicationEvidence | UnverifiedEvidence; reason: "index-locked";
    lock: IndexLockIdentity & { path: string; journaledPid?: number }; message: string;
  };

export type CommitRecoveryResult = FinishedRecovery
  | { status: "skipped"; phase: SkipPhase }
  | { status: "skipped"; reason: "missing-job" };

export type CommitRecoveryJobKey = Pick<RecoveryJob, "project" | "request">;

export interface CommitRecoveryPorts<Job extends CommitRecoveryJournal> {
  /** Load the current durable job inside the repository queue, including terminal records. */
  reload(key: CommitRecoveryJobKey): Promise<Job | null>;
  /** Durably attach this checkpoint to the original journal record before the next Git mutation. */
  checkpoint(job: Job, checkpoint: CommitRecoveryCheckpoint): Promise<void>;
  /** Durably record the outcome. Preserve the checkpoint when blocked and clear it on other outcomes.
   * When keeping a job for Fix, store null to prevent future use of the original lock identity.
   * On done, settle ownership in the same write.
   */
  finish(job: Job, result: FinishedRecovery): Promise<void>;
}

const pendingByRepository = new Map<string, Promise<void>>();
const execGit = promisify(execFile);
const INTENT_TO_ADD = 0x20000000;
// These flags carry user state. Other flags include the stage, path length and Git's caches.
const USER_FLAGS = 0x8000 | INTENT_TO_ADD | 0x40000000;
// `--debug` appends cached stat data after each NUL-terminated path. Fail closed on an unknown format.
const INDEX_STAT = /  ctime: \d+:\d+\n  mtime: \d+:\d+\n  dev: \d+\tino: \d+\n  uid: \d+\tgid: \d+\n  size: \d+\tflags: ([\da-f]+)\n/y;

type IndexEntry = { entry: string; flags: number };
type IndexSnapshot = Map<string, IndexEntry[]>;

async function readGit(root: string, args: string[], indexPath?: string): Promise<Buffer> {
  const { stdout, stderr } = await execGit("git", [
    "--no-pager", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.sparseCheckout=false", ...args,
  ], {
    cwd: root, encoding: "buffer", timeout: 5_000, maxBuffer: 128 << 20,
    env: {
      ...process.env, LC_ALL: "C", GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined,
      GIT_NAMESPACE: undefined, GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
      GIT_QUARANTINE_PATH: undefined, GIT_INDEX_FILE: indexPath, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1",
    },
  });
  if (stderr.length) throw new Error(stderr.toString().trimEnd());
  return stdout;
}

async function fileInfo(path: string) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readIndex(root: string, path: string): Promise<IndexSnapshot> {
  const info = await fileInfo(path);
  if (info === null) return new Map();
  if (!info.isFile()) throw new Error("The Git index must be a regular file");
  const output = (await readGit(root, ["ls-files", "--full-name", "--stage", "--debug", "-z"], path)).toString("latin1");
  const snapshot: IndexSnapshot = new Map();
  for (let offset = 0; offset < output.length;) {
    const tab = output.indexOf("\t", offset);
    const end = output.indexOf("\0", offset);
    const entry = output.slice(offset, tab);
    INDEX_STAT.lastIndex = end + 1;
    const flags = INDEX_STAT.exec(output)?.[1];
    if (tab < 0 || end <= tab || !flags || !/^\d{6} [a-f0-9]{40}(?:[a-f0-9]{24})? [0-3]$/.test(entry)) {
      throw new Error("Git returned an invalid index entry");
    }
    // Keep path bytes reversible, including unselected paths that cannot be represented as UTF-8.
    const pathKey = output.slice(tab + 1, end);
    const entries = snapshot.get(pathKey) ?? [];
    entries.push({ entry, flags: Number.parseInt(flags, 16) & USER_FLAGS });
    snapshot.set(pathKey, entries);
    offset = INDEX_STAT.lastIndex;
  }
  return snapshot;
}

const pathKey = (path: string): string => Buffer.from(path).toString("latin1");

function matchesEntry(actual: IndexEntry[] | undefined, expected: GitTreeEntry | null): boolean {
  if (expected === null) return actual === undefined;
  const entry = actual?.[0];
  return actual?.length === 1 && entry?.entry === `${expected.mode} ${expected.oid} 0` && !(entry.flags & INTENT_TO_ADD);
}

function matchesEntries(snapshot: IndexSnapshot, entries: readonly GitEntryChange[], side: "base" | "next"): boolean {
  return entries.every((change) => matchesEntry(snapshot.get(pathKey(change.path)), change[side]));
}

function preservesOtherEntries(real: IndexSnapshot, prepared: IndexSnapshot, entries: readonly GitEntryChange[]): boolean {
  const selected = new Set(entries.map(({ path }) => pathKey(path)));
  for (const path of new Set([...real.keys(), ...prepared.keys()])) {
    if (selected.has(path)) continue;
    const before = real.get(path);
    const after = prepared.get(path);
    if (!before || !after || before.length !== after.length || before.some(({ entry, flags }, i) =>
      entry !== after[i]?.entry || flags !== after[i]?.flags)) return false;
  }
  return true;
}

function reasonText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function repositoryChanged(message: string): FinishedRecovery {
  return { status: "blocked", evidence: "unverified", reason: "repository-changed", message };
}

async function resolveIndex(job: RecoveryJob & { indexPath?: string }, repository: string): Promise<string> {
  const root = job.project.root;
  if (!isAbsolute(root)) throw new Error("The Git worktree path must be absolute");
  async function gitPath(option: "--git-common-dir" | "--show-toplevel"): Promise<string> {
    const output = await readGit(root, ["rev-parse", "--path-format=absolute", option]);
    const record = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output);
    const path = record.slice(0, -1);
    if (!record.endsWith("\n") || !isAbsolute(path)) throw new Error(`Git did not report an absolute ${option} path`);
    return realpath(path);
  }
  const [indexPath, commonDir, topLevel, canonicalRoot] = await Promise.all([
    gitIndexPath(root), gitPath("--git-common-dir"), gitPath("--show-toplevel"), realpath(root),
  ]);
  if (commonDir !== repository || topLevel !== canonicalRoot || (job.indexPath !== undefined && job.indexPath !== indexPath)) {
    throw new Error("The journal no longer matches this Git worktree");
  }
  return indexPath;
}

function mayHavePublished(job: CommitRecoveryJournal): job is CommitRepairJournal {
  return job.phase === "index-ready" || job.phase === "indeterminate" ||
    (job.phase === "publishing" && job.step !== "cleanup");
}

function previousOwner(job: CommitRecoveryJournal): JournaledIndexLock | undefined {
  if (job.recovery !== undefined) return job.recovery && "owner" in job.recovery ? job.recovery.owner : undefined;
  return "lock" in job && job.lock ? { ...job.lock, pid: job.pid } : undefined;
}

async function blockedIndex(indexPath: string, owner: JournaledIndexLock | undefined, evidence: FinishedRecovery["evidence"]): Promise<FinishedRecovery | null> {
  const path = indexPath + ".lock";
  const info = await fileInfo(path);
  if (!info) return null;
  const device = String(info.dev);
  const inode = String(info.ino);
  const journaledPid = info.isFile() && owner?.device === device && owner.inode === inode ? owner.pid : undefined;
  const holder = journaledPid === undefined ? "an unrecognized lock" : `Vizzo job process ${journaledPid}`;
  return {
    status: "blocked", evidence, reason: "index-locked", lock: { path, device, inode, journaledPid },
    message: `Git's index is locked by ${holder} at ${path}`,
  };
}

function repairNeeded(job: CommitRepairJournal, reason: RepairReason, canFix: boolean, detail: string): FinishedRecovery {
  return {
    status: "repair-needed", evidence: "published", commit: job.commit, reason, canFix,
    message: `Vizzo committed ${job.commit}, but couldn't verify or update Git's staging area. ${detail}`,
  };
}

const baseIndexWarning = "Git's staging area still has the previous entries. Committing now would undo the recovered commit.";

async function repairIndex(
  job: CommitRepairJournal, index: IndexLock, reusable: boolean, head: GitHead,
  checkpoint: (state: CommitRecoveryCheckpoint) => Promise<void>,
): Promise<FinishedRecovery> {
  const root = job.project.root;
  const indexPath = index.indexPath;
  const owner = { ...index.identity, pid: process.pid };
  const real = await readIndex(root, indexPath).catch((error: unknown) => reasonText(error));
  const validEntries = job.entries.length > 0 && new Set(job.entries.map(({ path }) => path)).size === job.entries.length;
  // The index may have been installed before HEAD moved and the journal settled.
  if (typeof real !== "string" && validEntries && matchesEntries(real, job.entries, "next")) {
    return { status: "done", evidence: "published", commit: job.commit, index: "already-current" };
  }

  if (head.branch !== job.head.branch) return repairNeeded(job, "branch-switched", false, "HEAD points to a different branch.");
  if (head.oid !== job.commit) return repairNeeded(job, "branch-tip-changed", false, "The original branch tip changed.");
  if (typeof real === "string") return repairNeeded(job, "index-error", true, real);
  if (!validEntries) {
    return repairNeeded(job, "index-error", false, "The commit journal has invalid selected entries.");
  }
  if (!matchesEntries(real, job.entries, "base") || job.entries.some(({ path }) => real.get(pathKey(path))?.[0]?.flags)) {
    return repairNeeded(job, "index-changed", false, "The selected paths have staged changes or user flags.");
  }

  if (reusable) {
    // A valid checksum alone does not show that these bytes still preserve the user's staging.
    const previous = await readIndex(root, indexPath + ".lock").catch(() => null);
    if (previous && matchesEntries(previous, job.entries, "next") &&
        !job.entries.some(({ path }) => previous.get(pathKey(path))?.[0]?.flags) &&
        preservesOtherEntries(real, previous, job.entries)) {
      await checkpoint({ step: "install-index", owner, reusable: true });
      try {
        await index.install("published");
        return { status: "done", evidence: "published", commit: job.commit, index: "reused" };
      } catch (error) {
        if (!(error instanceof GitPublicationError) || error.code !== "index-not-ready") {
          return repairNeeded(job, "index-error", true, `${baseIndexWarning} ${reasonText(error)}`);
        }
      }
    }
  }

  await checkpoint({ step: "write-index", owner, reusable: false });
  try {
    const bytes = await prepareIndexBytes({ root, indexPath, entries: job.entries });
    await index.write(bytes);
  } catch (error) {
    return repairNeeded(job, "index-error", true, `${baseIndexWarning} ${reasonText(error)}`);
  }
  await checkpoint({ step: "install-index", owner, reusable: true });
  try {
    await index.install("published");
    return { status: "done", evidence: "published", commit: job.commit, index: "rebuilt" };
  } catch (error) {
    return repairNeeded(job, "index-error", true, reasonText(error));
  }
}

async function recover<Job extends CommitRecoveryJournal>(job: Job, repository: string, ports: CommitRecoveryPorts<Job>): Promise<CommitRecoveryResult> {
  async function finish(result: FinishedRecovery): Promise<FinishedRecovery> {
    await ports.finish(job, result);
    return result;
  }

  let indexPath: string;
  try { indexPath = await resolveIndex(job, repository); }
  catch (error) { return finish(repositoryChanged(reasonText(error))); }

  const root = job.project.root;
  const candidate = mayHavePublished(job) ? job : null;
  const mayHaveSentCommit = candidate?.phase === "index-ready" || candidate?.phase === "indeterminate";
  let evidence: PublicationEvidence | UnverifiedEvidence = candidate
    ? await classifyGitPublication(root, candidate.head, candidate.commit)
    : "not-attempted";
  // The Git child can survive a server crash and publish a queued commit. Until its prepared
  // transaction has ended, an unchanged branch and reflog do not prove non-publication.
  if (mayHaveSentCommit && evidence === "not-published") evidence = "unverified";

  const oldOwner = previousOwner(job);
  const abandoned = oldOwner && await reopenIndexLock(indexPath, oldOwner);
  const reusable = !!abandoned && (job.recovery
    ? "reusable" in job.recovery && job.recovery.reusable
    : job.phase === "index-ready");
  let index = abandoned;
  if (!index) {
    const blocked = await blockedIndex(indexPath, oldOwner, evidence);
    if (blocked) return finish(blocked);
    if (candidate && (mayHaveSentCommit || evidence === "published")) {
      await ports.checkpoint(job, { step: "acquire-index" });
      try { index = await acquireIndexLock(indexPath, 0); }
      catch (error) {
        const blocked = await blockedIndex(indexPath, oldOwner, evidence);
        if (blocked) return finish(blocked);
        if (evidence === "published") return finish(repairNeeded(candidate, "index-error", true, reasonText(error)));
        return finish(publicationBusy(evidence, error));
      }
    }
  }

  const checkpoint = (state: CommitRecoveryCheckpoint) => ports.checkpoint(job, state);
  let canReleaseOnError = !abandoned;
  try {
    if (candidate && index && (mayHaveSentCommit || evidence === "published")) {
      const owner = { ...index.identity, pid: process.pid };
      // Leave the original ownership intact until we know it is safe to mutate the orphan lock.
      if (!abandoned) await checkpoint({ step: "inspect-index", owner, reusable });
      let head: GitHead;
      let ref;
      try {
        head = await captureGitHead(root);
        ref = await prepareGitRefVerify(root, head);
        canReleaseOnError = true;
      } catch (error) {
        const outcome = publicationBusy(evidence, error);
        return finish(abandoned ? outcome : await releaseIndex(index, outcome, reusable, owner, checkpoint));
      }
      let outcome: FinishedRecovery;
      try {
        evidence = await classifyGitPublication(root, candidate.head, candidate.commit);
        if (evidence === "published") {
          if (abandoned) await checkpoint({ step: "inspect-index", owner, reusable });
          const verifiedHead = await captureGitHead(root);
          outcome = await repairIndex(candidate, index, reusable, verifiedHead, checkpoint);
        } else {
          outcome = unconfirmed(candidate, evidence);
        }
        outcome = await releaseIndex(index, outcome, reusable, owner, checkpoint);
      } finally { await ref.close(); }
      return finish(outcome);
    }

    const outcome = candidate ? unconfirmed(candidate, evidence === "not-published" ? evidence : "indeterminate") : {
      status: "refused" as const, evidence: "not-attempted" as const,
      refusal: "refusal" in job && job.refusal ? job.refusal : {
        code: "interrupted", reason: "Vizzo stopped before attempting to publish this commit.",
      },
    };
    if (!index) return finish(outcome);
    // An early-phase orphan cannot have sent commit. Keep its dead-owner identity in the
    // cleanup checkpoint so a retry can reopen it if the checkpoint write fails.
    const owner = abandoned && oldOwner ? oldOwner : { ...index.identity, pid: process.pid };
    return finish(await releaseIndex(index, outcome, reusable, owner, checkpoint));
  } catch (error) {
    if (canReleaseOnError && index) {
      try { await index.release(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Commit recovery could not release its Git index lock");
      }
    }
    throw error;
  } finally { await index?.close(); }
}

function publicationBusy(evidence: FinishedRecovery["evidence"], error: unknown): FinishedRecovery {
  const detail = reasonText((error as Error | null)?.cause ?? error);
  return {
    status: "blocked", reason: "publication-busy", evidence, canFix: true,
    message: `Git could not verify HEAD for commit recovery. ${detail}`,
  };
}

function unconfirmed(job: CommitRepairJournal, evidence: "not-published" | "indeterminate"): FinishedRecovery {
  const message = evidence === "not-published"
    ? "Git did not publish this commit."
    : "Vizzo can't tell whether this commit was made. Check git log.";
  return { status: evidence, evidence, commit: job.commit, message };
}

async function releaseIndex(
  index: IndexLock, outcome: FinishedRecovery, reusable: boolean, owner: JournaledIndexLock,
  checkpoint: (state: CommitRecoveryCheckpoint) => Promise<void>,
): Promise<FinishedRecovery> {
  // A successful install has already released the lock. Attempt release for an already-current index
  // as well, so an orphan is cleaned if the index had been independently installed.
  if (outcome.status === "done" && outcome.index !== "already-current") return outcome;
  await checkpoint({ step: "cleanup", owner, reusable });
  if (!(await index.release())) return (await blockedIndex(index.indexPath, owner, outcome.evidence)) ?? outcome;
  return outcome;
}

/** Invoke for each journaled job before enabling writers. Startup and Fix are serialized per repository in this server. */
export async function recoverCommit<Job extends CommitRecoveryJournal>(key: CommitRecoveryJobKey, ports: CommitRecoveryPorts<Job>): Promise<CommitRecoveryResult> {
  let repository: string;
  try {
    if (!isAbsolute(key.project.commonDir)) throw new Error("The Git common directory path must be absolute");
    repository = await realpath(key.project.commonDir);
  } catch (error) { return repositoryChanged(reasonText(error)); }

  const pending = (pendingByRepository.get(repository) ?? Promise.resolve()).then(async (): Promise<CommitRecoveryResult> => {
    const latest = await ports.reload(key);
    if (!latest) return { status: "skipped", reason: "missing-job" };
    if (latest.request.jobId !== key.request.jobId || latest.project.root !== key.project.root ||
        latest.project.commonDir !== key.project.commonDir) {
      return repositoryChanged("The journal no longer matches this Git worktree and job");
    }
    if (latest.phase === "done" || latest.phase === "refused" || latest.phase === "not-published") {
      return { status: "skipped", phase: latest.phase };
    }
    return recover(latest, repository, ports);
  });
  const barrier = pending.then(() => {}, () => {});
  pendingByRepository.set(repository, barrier);
  try { return await pending; }
  finally {
    if (pendingByRepository.get(repository) === barrier) pendingByRepository.delete(repository);
  }
}

/** Reclassify publication and run the same guarded repair against the current index and HEAD. */
export function fixCommitIndex<Job extends CommitRecoveryJournal>(job: CommitRepairJournal, ports: CommitRecoveryPorts<Job>): Promise<CommitRecoveryResult> {
  return recoverCommit(job, ports);
}
