import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  acquireIndexLock, captureGitHead, classifyGitPublication, GitPublicationError, gitIndexPath, prepareGitRefUpdate,
  type GitHead, type IndexLock, type IndexLockIdentity, type PreparedGitRefUpdate, type RefCommitResult,
} from "./gitPublication.ts";
import { buildCommitTree, prepareIndexBytes, type FrozenGitEntry, type GitEntryChange } from "./gitTree.ts";

export interface CommitProject {
  readonly id: string;
  readonly root: string;
  readonly commonDir: string;
}

export type CommitSelection =
  | { readonly kind: "explicit"; readonly otherComponentIds: readonly string[] }
  | { readonly kind: "writer" | "delete"; readonly writerId: string };

export interface CommitRequest {
  readonly jobId: string;
  readonly projectId: string;
  readonly generation: number;
  readonly componentIds: readonly string[];
  /** All owners in the selected components, including tied writers, from the requested generation. */
  readonly writerIds: readonly string[];
  readonly selection: CommitSelection;
  readonly message: string;
}

export interface FrozenCommitComponent {
  readonly id: string;
  readonly paths: readonly string[];
  readonly writerIds: readonly string[];
  readonly other: boolean;
  readonly incomplete: boolean;
}

export interface FrozenCommitSelection<Ownership> {
  /** The requested generation whose selected components the fresh scan proved equivalent. */
  readonly generation: number;
  readonly components: readonly FrozenCommitComponent[];
  readonly workingWriterIds: readonly string[];
  readonly entries: readonly FrozenGitEntry[];
  /** Immutable, serializable ledger data needed to drop the committed ownership, including after restart. */
  readonly ownership: Ownership;
}

interface CommitJob {
  readonly project: CommitProject;
  readonly request: CommitRequest;
  readonly pid: number;
}

interface IndexLocation {
  readonly indexPath: string;
}

export interface CommitContext extends CommitJob, IndexLocation {
  readonly lock: IndexLockIdentity;
  readonly head: Readonly<GitHead>;
}

interface BuiltCommit<Ownership> extends CommitContext {
  readonly tree: string;
  readonly commit: string;
  readonly entries: readonly GitEntryChange[];
  readonly ownership: Ownership;
}

interface Refusal {
  readonly code: string;
  readonly reason: string;
}

type Cleanup = Partial<IndexLocation & Pick<CommitContext, "lock" | "head">> & { readonly refusal: Refusal };

type LockingJournal<Ownership> = { readonly phase: "locking" } & (
  | (CommitJob & { readonly step: "resolve-index" })
  | (CommitJob & IndexLocation & { readonly step: "acquire-index" })
  | (CommitJob & IndexLocation & { readonly step: "capture-base"; readonly lock: IndexLockIdentity })
  | (CommitContext & { readonly step: "reserve-writers" | "freeze-selection" | "validate-selection" })
  | (CommitContext & { readonly step: "build-commit"; readonly ownership: Ownership })
  | (CommitJob & Cleanup & { readonly step: "cleanup" })
);

type PublishingJournal<Ownership> = BuiltCommit<Ownership> & { readonly phase: "publishing" } & (
  | { readonly step: "prepare-ref" | "prepare-index" | "write-index" }
  | { readonly step: "cleanup"; readonly refusal: Refusal }
);

type IndexReadyJournal<Ownership> = BuiltCommit<Ownership> & { readonly phase: "index-ready" } & (
  | { readonly step: "publish" }
  | { readonly step: "classify"; readonly receipt: RefCommitResult }
  | { readonly step: "install"; readonly receipt: RefCommitResult; readonly evidence: "published" }
  | { readonly step: "repair"; readonly receipt: RefCommitResult; readonly evidence: "published"; readonly reason: string }
  | { readonly step: "release"; readonly receipt: RefCommitResult; readonly evidence: "not-published" | "indeterminate" }
);

export type CommitSettlement<Ownership> = BuiltCommit<Ownership> & {
  readonly phase: "done";
  readonly receipt: RefCommitResult;
  readonly evidence: "published";
};

export type CommitJournal<Ownership> =
  | LockingJournal<Ownership>
  | PublishingJournal<Ownership>
  | IndexReadyJournal<Ownership>
  | (CommitJob & Cleanup & { readonly phase: "refused" })
  | (BuiltCommit<Ownership> & {
    readonly phase: "not-published" | "indeterminate";
    readonly receipt: RefCommitResult;
    readonly reason: string;
  })
  | CommitSettlement<Ownership>;

export type CommitResult =
  | { readonly status: "done"; readonly commit: string }
  | ({ readonly status: "refused" } & Refusal)
  | { readonly status: "not-published" | "indeterminate" | "repair-needed"; readonly commit: string; readonly reason: string };

export interface CommitTransactionPorts<Ownership> {
  /** Durably replace the job's journal record. Keep ledger ownership and closed groups intact. */
  journal(record: Exclude<CommitJournal<Ownership>, CommitSettlement<Ownership>>): Promise<void>;
  /** Atomically reserve all requested writers against new executions and return a synchronous release. Existing runs must still be reported. */
  reserveWriters(context: CommitContext): Promise<() => void>;
  /** Scan against the captured HEAD and re-resolve the exact selection, including paths, bytes, ties and registry state.
   * Return null if the requested generation cannot be revalidated. Existing staged or unsupported entries must be
   * assessed by the scanner and Git primitives. Every entry returned contains only content the selection authorizes.
   */
  scanAndFreeze(context: CommitContext): Promise<FrozenCommitSelection<Ownership> | null>;
  /** In one durable ledger mutation, mark the job done and drop exactly the committed ownership. */
  settle(record: CommitSettlement<Ownership>): Promise<void>;
}

const pendingByRepository = new Map<string, Promise<void>>();
const reviewAgain = "Changed meanwhile: review again";

class SelectionError extends Error {
  constructor(readonly code: "selection" | "stale" | "working" | "other" | "delete-selection", message: string) {
    super(message);
  }
}

function validateRequest({ project, request }: CommitJob): void {
  const components = new Set(request.componentIds);
  if (request.projectId !== project.id || components.size === 0 || components.size !== request.componentIds.length ||
      new Set(request.writerIds).size !== request.writerIds.length) {
    throw new SelectionError("selection", "Invalid commit selection");
  }
  if (request.selection.kind === "explicit" && request.selection.otherComponentIds.some((id) => !components.has(id))) {
    throw new SelectionError("selection", "Other must be ticked on a selected component");
  }
}

function snapshotSelection<Ownership>(selection: FrozenCommitSelection<Ownership> | null): FrozenCommitSelection<Ownership> | null {
  if (selection === null) return null;
  return {
    ...selection,
    components: selection.components.map((component) => ({
      ...component, paths: [...component.paths], writerIds: [...component.writerIds],
    })),
    workingWriterIds: [...selection.workingWriterIds],
    ownership: structuredClone(selection.ownership),
    entries: selection.entries.map((entry) => entry.content === null
      ? { ...entry }
      : { ...entry, content: Buffer.from(entry.content) }),
  };
}

function validateFrozen<Ownership>(request: CommitRequest, frozen: FrozenCommitSelection<Ownership> | null): asserts frozen is FrozenCommitSelection<Ownership> {
  if (!frozen || frozen.generation !== request.generation || frozen.components.length !== request.componentIds.length) {
    throw new SelectionError("stale", reviewAgain);
  }

  const expectedComponents = new Set(request.componentIds);
  const expectedWriters = new Set(request.writerIds);
  const actualWriters = new Set<string>();
  const expectedPaths = new Set<string>();
  const working = new Set(frozen.workingWriterIds);
  const selection = request.selection;
  const otherTicked = new Set(selection.kind === "explicit" ? selection.otherComponentIds : []);
  for (const { id, writerIds, paths, other, incomplete } of frozen.components) {
    if (!expectedComponents.delete(id) || !paths.length || (!writerIds.length && !other) ||
        writerIds.some((writer) => !expectedWriters.has(writer))) {
      throw new SelectionError("stale", reviewAgain);
    }
    if (writerIds.some((writer) => working.has(writer))) {
      throw new SelectionError("working", `${reviewAgain}. A selected writer is still working.`);
    }
    if (selection.kind === "delete" && (other || incomplete || writerIds.length !== 1 || writerIds[0] !== selection.writerId)) {
      throw new SelectionError("delete-selection", `${reviewAgain}. Delete can commit only the thread's own completed work.`);
    }
    if (other && !otherTicked.has(id)) throw new SelectionError("other", `${reviewAgain}. Other must be ticked explicitly.`);
    if (selection.kind === "writer" && (writerIds.length !== 1 || writerIds[0] !== selection.writerId)) {
      throw new SelectionError("selection", "A writer selection can include only its own components");
    }
    for (const writer of writerIds) actualWriters.add(writer);
    for (const path of paths) expectedPaths.add(path);
  }
  if (actualWriters.size !== expectedWriters.size || frozen.entries.some(({ path }) => !expectedPaths.delete(path)) || expectedPaths.size) {
    throw new SelectionError("stale", reviewAgain);
  }
}

function asRefusal(error: unknown): Refusal {
  return {
    code: error instanceof SelectionError || error instanceof GitPublicationError ? error.code : "git-or-ledger",
    reason: error instanceof Error ? error.message : String(error),
  };
}

async function executeCommit<Ownership>(job: CommitJob, ports: CommitTransactionPorts<Ownership>): Promise<CommitResult> {
  const root = job.project.root;
  let indexPath: string | undefined;
  let index: IndexLock | undefined;
  let head: GitHead | undefined;
  let built: BuiltCommit<Ownership> | undefined;
  let releaseWriters: (() => void) | undefined;
  let ref: PreparedGitRefUpdate | undefined;
  let publicationStarted = false;
  try {
    validateRequest(job);
    await ports.journal({ ...job, phase: "locking", step: "resolve-index" });
    indexPath = await gitIndexPath(root);
    await ports.journal({ ...job, indexPath, phase: "locking", step: "acquire-index" });
    index = await acquireIndexLock(indexPath);
    await ports.journal({ ...job, indexPath, lock: index.identity, phase: "locking", step: "capture-base" });
    head = await captureGitHead(root);
    const captured = { ...job, indexPath, lock: index.identity, head };

    await ports.journal({ ...captured, phase: "locking", step: "reserve-writers" });
    releaseWriters = await ports.reserveWriters(captured);
    await ports.journal({ ...captured, phase: "locking", step: "freeze-selection" });
    // Copy the scanner's snapshot before another await can expose it to edits to its cache.
    const frozen = snapshotSelection(await ports.scanAndFreeze(captured));
    await ports.journal({ ...captured, phase: "locking", step: "validate-selection" });
    validateFrozen(job.request, frozen);

    await ports.journal({ ...captured, ownership: frozen.ownership, phase: "locking", step: "build-commit" });
    const candidate = await buildCommitTree({
      root, indexPath, base: head.oid, entries: frozen.entries, message: job.request.message,
    });
    built = { ...captured, ...candidate, ownership: frozen.ownership };
    await ports.journal({ ...built, phase: "publishing", step: "prepare-ref" });
    ref = await prepareGitRefUpdate(root, head, candidate.commit);
    await ports.journal({ ...built, phase: "publishing", step: "prepare-index" });
    const preparedIndex = await prepareIndexBytes({ root, indexPath, entries: built.entries });
    await ports.journal({ ...built, phase: "publishing", step: "write-index" });
    await index.write(preparedIndex);
    await ports.journal({ ...built, phase: "index-ready", step: "publish" });

    publicationStarted = true;
    const receipt = await ref.commit();
    ref = undefined;
    await ports.journal({ ...built, phase: "index-ready", step: "classify", receipt });
    const evidence = await classifyGitPublication(root, head, candidate.commit, receipt);
    if (evidence === "published") {
      await ports.journal({ ...built, phase: "index-ready", step: "install", receipt, evidence });
      try {
        await index.install(evidence);
      } catch (error) {
        const reason = `Vizzo committed ${candidate.commit}, but Git's staging area wasn't updated: ${asRefusal(error).reason}`;
        await ports.journal({ ...built, phase: "index-ready", step: "repair", receipt, evidence, reason });
        await index.release();
        return { status: "repair-needed", commit: candidate.commit, reason };
      }
      await ports.settle({ ...built, phase: "done", receipt, evidence });
      return { status: "done", commit: candidate.commit };
    }

    await ports.journal({ ...built, phase: "index-ready", step: "release", receipt, evidence });
    await index.release();
    const reason = evidence === "indeterminate"
      ? "Vizzo can't tell whether this commit was made: check git log"
      : receipt.kind === "failed" ? `Git did not publish this commit: ${receipt.detail}` : "Git did not publish this commit";
    await ports.journal({ ...built, phase: evidence, receipt, reason });
    return { status: evidence, commit: candidate.commit, reason };
  } catch (error) {
    if (publicationStarted) {
      // The ref may have moved. Leave the last durable checkpoint and any owned lock for recovery.
      try { await ref?.close(); }
      finally { await index?.close(); }
      throw error;
    }

    const refusal = asRefusal(error);
    const cleanup = { ...job, ...(indexPath && { indexPath }), ...(index && { lock: index.identity }), ...(head && { head }), refusal };
    try {
      if (built) await ports.journal({ ...built, phase: "publishing", step: "cleanup", refusal });
      else await ports.journal({ ...cleanup, phase: "locking", step: "cleanup" });
    } finally {
      try { await ref?.abort(); }
      finally { await index?.release(); }
    }
    await ports.journal({ ...cleanup, phase: "refused" });
    return { status: "refused", ...refusal };
  } finally {
    releaseWriters?.();
  }
}

/** Serialize commits across projects and linked worktrees sharing a repository in this process. */
export async function runCommitTransaction<Ownership>(project: CommitProject, request: CommitRequest, ports: CommitTransactionPorts<Ownership>): Promise<CommitResult> {
  if (!isAbsolute(project.root) || !isAbsolute(project.commonDir)) throw new Error("Git project paths must be absolute");
  const selection = request.selection;
  const job = {
    project: { ...project },
    request: {
      ...request,
      componentIds: [...request.componentIds],
      writerIds: [...request.writerIds],
      selection: selection.kind === "explicit" ? { ...selection, otherComponentIds: [...selection.otherComponentIds] } : { ...selection },
    },
    pid: process.pid,
  };
  const repository = await realpath(project.commonDir);
  const pending = (pendingByRepository.get(repository) ?? Promise.resolve()).then(() => executeCommit(job, ports));
  const barrier = pending.then(() => {}, () => {});
  pendingByRepository.set(repository, barrier);
  try { return await pending; }
  finally {
    if (pendingByRepository.get(repository) === barrier) pendingByRepository.delete(repository);
  }
}
