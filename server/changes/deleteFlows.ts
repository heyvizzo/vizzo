import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readChangesPreferences } from "../../electron/settings.ts";
import { beginTask } from "../activity.ts";
import type { CommitScan } from "./changesService.ts";
import type { CommitRequest, CommitResult } from "./commitTransaction.ts";
import { carryChangesAfterPublication, changeWriterId, writerWork, type ChangeOwnershipReceipt } from "./components.ts";
import type { ThreadDeleteContext, ThreadDeleteHandoff } from "./ledger.ts";
import { isLedgerCommitPinned, type LedgerWorkerClient } from "./ledgerWorkerClient.ts";
import { prepareCommitMessage } from "./message.ts";
import { closedMessageContext, type CommitContextMessage } from "./messageContext.ts";
import type { LedgerProject } from "./project.ts";
import { isGitScanUnavailable, REVIEW_AGAIN, type ScanGroupState, type ScanReview, type ScanRuntime } from "./scanRuntime.ts";
import type { ProjectWriterSnapshot, WriterRegistry } from "./writers.ts";

export interface ThreadDeleteTarget {
  threadId: string;
  title: string;
  folder: string | null;
  requests: readonly string[];
  summary?: string;
  messageContext?: readonly CommitContextMessage[];
  mode: "commit" | "keep";
  working?: boolean;
  interruptedExecutionId?: string;
}

export interface ThreadDeletePreview {
  threadId: string;
  state: "none" | "complete" | "incomplete" | "working";
  reason?: string;
  defaultMode: "commit" | "keep";
  willCommit?: boolean;
  owned?: boolean;
  incompleteReason?: string;
  continuesExecutionId?: string;
  continuationRequest?: string;
  continuationSessionId?: string;
}

export interface ThreadDeletePorts {
  prepare?(): void | Promise<void>;
  verifyCommit?(): void;
  stop(threadId: string): void | Promise<void>;
  /** Flush the thread store durably and throw on failure. */
  remove(threadIds: readonly string[]): void | Promise<void>;
}

export type DeleteLedger = Pick<LedgerWorkerClient, "discover" | "threadDeleteContexts" | "handoffThreadDeletes" |
  "pendingThreadDeletes" | "completeThreadDeletes" | "closedThreads" | "carryThreadDeleteCommit" | "commitJob" | "finishRecovery">;

interface DeleteServices {
  ledger: DeleteLedger;
  writers: Pick<WriterRegistry, "snapshot" | "reserve">;
  scanner: ScanRuntime;
  inRepository: <T>(project: LedgerProject, task: () => Promise<T>) => Promise<T>;
  commit: (project: LedgerProject, request: CommitRequest, freeze: CommitScan) => Promise<CommitResult>;
}

interface Preflight {
  target: ThreadDeleteTarget;
  preview: ThreadDeletePreview;
  project?: LedgerProject;
  handoff?: ThreadDeleteHandoff;
  review?: ScanReview;
}

interface DeleteJob {
  threadId: string;
  title: string;
  messages: readonly CommitContextMessage[];
  review: ScanReview;
  request: CommitRequest;
  persisted: CommitRequest;
  finish: ReturnType<typeof beginTask>;
}

const STOPPED = "Kept uncommitted because the thread was working when deletion began";
const NO_WORKTREE = "The project folder is not in a Git worktree";
const UNSUPPORTED = new Set(["Source control requires Git 2.41 or later", "This Git cannot read attributes from a selected tree"]);

function detail(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function fallbackMessage(target: ThreadDeleteTarget): string {
  const clean = (text: string) => text.replaceAll("\0", "").trim().slice(0, 600);
  const title = clean(target.title) || "Commit thread changes";
  const request = target.requests.map(clean).find(Boolean);
  return request && request !== title ? `${title}\n\n${request}` : title;
}

function registryWorking(snapshot: ProjectWriterSnapshot, threadId: string): boolean {
  return snapshot.executions.some((execution) => execution.writer.kind === "thread" && execution.writer.id === threadId &&
    (execution.phase !== "settled" || execution.pending));
}

function stateFor(target: ThreadDeleteTarget, review: ScanReview, initial: ProjectWriterSnapshot): ThreadDeletePreview {
  const writer = { kind: "thread" as const, id: target.threadId };
  const { status, group, incomplete } = writerWork(review.graph, writer, target.interruptedExecutionId);
  const owned = !!group && !!(group.own.length || group.tied.length);
  const working = target.working || registryWorking(initial, target.threadId) ||
    status?.state === "working" || status?.state === "stopping";
  const preview: ThreadDeletePreview = { threadId: target.threadId, state: "none", defaultMode: "keep", willCommit: false, owned };
  if (incomplete) {
    preview.incompleteReason = incomplete.reason;
    if (incomplete.continuation && !working) {
      preview.continuesExecutionId = incomplete.continuation.executionId;
      preview.continuationRequest = incomplete.continuation.request;
      preview.continuationSessionId = incomplete.continuation.nativeSessionId;
    }
  }
  if (working) return { ...preview, state: "working", reason: status?.reason ?? STOPPED };
  if (incomplete) return { ...preview, state: "incomplete", reason: incomplete.reason };
  if (!group || !owned) return preview;
  const complete: ThreadDeletePreview = { ...preview, state: "complete", defaultMode: "commit" };
  if (!group.own.length) return { ...complete, reason: tiedReason(review, target, group.tied, true) };
  const selected = new Set(group.own);
  const blocked = review.view.components.find(({ id, selectable, requires }) =>
    selected.has(id) && (!selectable || requires?.some((required) => !selected.has(required))));
  if (blocked) return { ...complete, reason: blocked.reason ?? "The changes depend on another component" };
  return { ...complete, willCommit: true };
}

function tiedReason(review: ScanReview, target: ThreadDeleteTarget, tied: readonly string[], only: boolean): string {
  const tiedIds = new Set(tied);
  const components = review.view.components.filter(({ id }) => tiedIds.has(id));
  const others = new Set(components.flatMap(({ writers }) => writers
    .filter(({ kind, id }) => kind !== "thread" || id !== target.threadId).map(changeWriterId)));
  const titles = review.view.groups.filter(({ writer }) => others.has(changeWriterId(writer))).map(({ title }) => `“${title}”`);
  const reasons = [];
  if (components.some(({ other }) => other)) reasons.push("also has Other changes");
  if (titles.length) reasons.push(`shares changes with ${titles.join(", ")}`);
  return `${only ? "No changes can be committed by this thread alone" : "Tied changes kept uncommitted"}${reasons.length ? ` (${reasons.join(" and ")})` : ""}`;
}

function handoff(target: ThreadDeleteTarget, preview: ThreadDeletePreview, review: ScanReview): ThreadDeleteHandoff {
  const writerId = changeWriterId({ kind: "thread", id: target.threadId });
  const group = review.view.groups.find(({ writer }) => changeWriterId(writer) === writerId);
  const request = target.mode === "commit" && preview.willCommit && group ? {
    jobId: randomUUID(), projectId: review.project.id, generation: review.view.generation, componentIds: group.own,
    writerIds: [writerId], selection: { kind: "delete" as const, writerId }, message: fallbackMessage(target),
  } : undefined;
  const tied = group?.tied.length ? tiedReason(review, target, group.tied, !group.own.length) : undefined;
  const reason = preview.state === "working" ? STOPPED
    : preview.reason ?? tied ?? (preview.owned && !request ? "Kept uncommitted" : undefined);
  return {
    project: review.project, threadId: target.threadId, title: target.title, requests: [...target.requests], summary: target.summary,
    messageContext: target.messageContext,
    reason, notice: !!preview.owned && !request && preview.state === "complete" && !!preview.reason, request,
  };
}

function unreviewed(target: ThreadDeleteTarget, project: LedgerProject, initial: ProjectWriterSnapshot, reason: string,
  closed?: ThreadDeleteContext["closed"]): Preflight {
  const working = target.working || registryWorking(initial, target.threadId);
  const explanation = `Vizzo couldn't review the changes. ${reason}`;
  return {
    target, project,
    preview: {
      threadId: target.threadId, state: working ? "working" : "none", defaultMode: "keep", willCommit: false,
      reason: `Changes will be kept uncommitted. ${explanation}`,
    },
    handoff: closed ? undefined : {
      project, threadId: target.threadId, title: target.title, requests: [...target.requests], summary: target.summary,
      messageContext: target.messageContext,
      reason: explanation, notice: true,
    },
  };
}

function uniqueTargets(targets: readonly ThreadDeleteTarget[]): ThreadDeleteTarget[] {
  const unique = new Map<string, ThreadDeleteTarget>();
  for (const target of targets) {
    const folder = target.folder ? resolve(target.folder) : null;
    const previous = unique.get(target.threadId);
    if (previous) {
      if (previous.folder !== folder) throw new Error("A thread was selected with two different project folders");
      if (target.mode === "keep") previous.mode = "keep";
      previous.working ||= target.working;
    } else {
      unique.set(target.threadId, { ...target, folder });
    }
  }
  return [...unique.values()];
}

export class ThreadDeletes {
  private deleting = Promise.resolve();
  private committing = Promise.resolve();

  constructor(private readonly services: DeleteServices) {}

  async groupState(project: Readonly<LedgerProject>): Promise<ScanGroupState> {
    const groups = await this.services.ledger.closedThreads(project);
    return {
      closedGroups: groups.map(({ threadId, title, reason, commitReason }) => ({
        writer: { kind: "thread", id: threadId }, title, reason: commitReason ?? reason,
      })),
      notices: groups.flatMap(({ title, reason, commitReason, notice }) => commitReason
        ? [`Couldn't commit “${title}”: ${commitReason}`]
        : notice && reason ? [`Kept “${title}” uncommitted. ${reason}.`] : []),
    };
  }

  async preview(targets: readonly ThreadDeleteTarget[]): Promise<ThreadDeletePreview[]> {
    return (await this.preflight(targets)).map(({ preview }) => preview);
  }

  delete(targets: readonly ThreadDeleteTarget[], ports: ThreadDeletePorts): Promise<ThreadDeletePreview[]> {
    const task = this.deleting.then(() => this.deleteBatch(targets, ports));
    this.deleting = task.then(() => {}, () => {});
    return task;
  }

  private async preflight(targets: readonly ThreadDeleteTarget[], reserve?: (project: LedgerProject, target: ThreadDeleteTarget) => void): Promise<Preflight[]> {
    const { ledger, writers, scanner, inRepository } = this.services;
    const unique = uniqueTargets(targets);
    if (!unique.length) return [];
    const contexts = new Map((await ledger.threadDeleteContexts(unique)).map((context) => [context.threadId, context]));
    const discovered = new Map<string, ReturnType<DeleteLedger["discover"]>>();
    const snapshots = new Map<string, Promise<ProjectWriterSnapshot>>();
    const scans = new Map<string, Promise<ScanReview>>();
    const checked = await Promise.allSettled(unique.map(async (target): Promise<Preflight> => {
      const context: ThreadDeleteContext | undefined = contexts.get(target.threadId);
      const { folder } = target;
      const preview: ThreadDeletePreview = {
        threadId: target.threadId, state: target.working ? "working" : "none", defaultMode: "keep", willCommit: false, owned: false,
        ...(target.working && { reason: STOPPED }),
      };
      if (!folder) return { target, preview };
      if (!discovered.has(folder)) discovered.set(folder, ledger.discover(folder));
      const found = await discovered.get(folder)!;
      const project = context?.project ?? found.project;
      if (!project) {
        if (found.reason !== NO_WORKTREE && !UNSUPPORTED.has(found.reason!) &&
            !found.reason?.startsWith("ENOENT:") && !found.reason?.startsWith("spawnSync git ENOENT")) throw new Error(found.reason);
        return { target, preview: { ...preview, ...(found.reason !== NO_WORKTREE && { reason: found.reason }) } };
      }
      reserve?.(project, target);
      if (!snapshots.has(project.id)) snapshots.set(project.id, writers.snapshot(project.id));
      const initial = await snapshots.get(project.id)!;
      if (!isDeepStrictEqual(project, found.project)) {
        return unreviewed(target, project, initial, `The pinned project changed. ${found.reason ?? REVIEW_AGAIN}`, context?.closed);
      }
      const scope = JSON.stringify(project);
      if (!scans.has(scope)) scans.set(scope, inRepository(project, () => scanner.reviewProject(project)));
      let review: ScanReview;
      try { review = await scans.get(scope)!; }
      catch (error) {
        if (isLedgerCommitPinned(error) || isGitScanUnavailable(error)) {
          return unreviewed(target, project, initial, detail(error), context?.closed);
        }
        throw error;
      }
      const state = stateFor(target, review, initial);
      if (context?.closed) return { target, preview: { ...state, defaultMode: "keep", willCommit: false }, project, review };
      return { target, preview: state, project, review, handoff: handoff(target, state, review) };
    }));
    return checked.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
  }

  private async deleteBatch(targets: readonly ThreadDeleteTarget[], ports: ThreadDeletePorts): Promise<ThreadDeletePreview[]> {
    const { ledger, writers } = this.services;
    const releases: (() => void)[] = [];
    const jobs: DeleteJob[] = [];
    let removed = false;
    try {
      const preflight = await this.preflight(targets, (project, target) => {
        releases.push(writers.reserve(project.id, [{ kind: "thread", id: target.threadId }]));
      });
      const snapshots = new Map<string, Promise<ProjectWriterSnapshot>>();
      for (const entry of preflight) {
        if (!entry.project || entry.preview.state === "working") continue;
        const { id } = entry.project;
        if (!snapshots.has(id)) snapshots.set(id, writers.snapshot(id));
      }
      await Promise.all(snapshots.values());
      for (const entry of preflight) {
        const initial = entry.project && await snapshots.get(entry.project.id);
        if (entry.preview.state === "working" || !initial || !registryWorking(initial, entry.target.threadId)) continue;
        entry.preview = entry.review ? stateFor({ ...entry.target, working: true }, entry.review, initial)
          : { ...entry.preview, state: "working" };
        if (entry.handoff && entry.review) entry.handoff = handoff(entry.target, entry.preview, entry.review);
      }
      ports.verifyCommit?.();
      await ports.prepare?.();
      await Promise.all(preflight.filter(({ preview }) => preview.state === "working").map(({ target }) => ports.stop(target.threadId)));
      ports.verifyCommit?.();
      const handoffs = preflight.flatMap(({ handoff }) => handoff ? [handoff] : []);
      const queued = new Set(handoffs.length ? (await ledger.handoffThreadDeletes(handoffs)).jobIds : []);
      for (const { handoff, review } of preflight) {
        const request = handoff?.request;
        if (review && request && queued.has(request.jobId)) jobs.push({
          threadId: handoff.threadId, title: handoff.title, messages: closedMessageContext(handoff),
          request, persisted: request, review, finish: beginTask(`Commit ${handoff.title}`),
        });
      }
      const ids = preflight.map(({ target }) => target.threadId);
      await ports.remove(ids);
      removed = true;
      if (ids.length) await ledger.completeThreadDeletes(ids);
      return preflight.map(({ preview }) => preview);
    } finally {
      for (const release of releases) release();
      this.runJobs(jobs, removed);
    }
  }

  private runJobs(jobs: readonly DeleteJob[], removed: boolean): void {
    if (!jobs.length) return;
    this.committing = this.committing.then(async () => {
      for (const [index, job] of jobs.entries()) {
        let finished = false;
        try {
          await this.services.inRepository(job.review.project, async () => {
            if (!removed) throw new Error("Vizzo could not finish removing the thread");
            const { result, receipt } = await this.runJob(job);
            if (result.status !== "done") {
              await this.refuseQueued(job, result.reason);
              return;
            }
            finished = true;
            if (receipt) await this.carryAfter(job, result.commit, receipt, jobs.slice(index + 1));
          });
        } catch (error) {
          await this.refuseQueued(job, detail(error));
        } finally {
          job.finish(finished ? "done" : "failed");
        }
      }
    }).catch((error) => console.warn("[changes] delete commit queue failed", error));
  }

  private async runJob(job: DeleteJob): Promise<{ result: CommitResult; receipt?: ChangeOwnershipReceipt }> {
    const { ledger, writers, commit } = this.services;
    const { review, persisted } = job;
    let request = job.request;
    const { autoCommitMessage, commitMessageTier } = readChangesPreferences();
    if (autoCommitMessage) {
      const selected = new Set(request.componentIds);
      const groups = review.view.groups.map((group) =>
        request.writerIds.includes(changeWriterId(group.writer)) ? { ...group, title: job.title } : group);
      const threads = new Map([[job.threadId, job.messages]]);
      const { message } = await prepareCommitMessage({ ...review, view: { ...review.view, groups } },
        review.view.components.filter(({ id }) => selected.has(id)),
        await writers.snapshot(review.project.id), { tier: commitMessageTier, fallback: request.message, threads });
      request = { ...request, message };
    }
    const key = { projectId: request.projectId, jobId: request.jobId };
    if (!isDeepStrictEqual(request, persisted) && !await ledger.carryThreadDeleteCommit(key, persisted, request)) throw new Error(REVIEW_AGAIN);
    let receipt: ChangeOwnershipReceipt | undefined;
    const result = await commit(review.project, request, async (context) => {
      const frozen = await review.scanAndFreeze(context);
      receipt = frozen?.ownership;
      return frozen;
    });
    return { result, receipt };
  }

  private async carryAfter(job: DeleteJob, commit: string, receipt: ChangeOwnershipReceipt, remaining: readonly DeleteJob[]): Promise<void> {
    const refreshed = new Map<ScanReview, ReturnType<ScanRuntime["reviewAfterPublication"]>>();
    for (const next of remaining) {
      if (next.review.project.id !== job.review.project.id || next.review.view.base !== job.review.view.base ||
          next.review.view.branch !== job.review.view.branch) continue;
      if (!refreshed.has(next.review)) refreshed.set(next.review, this.services.scanner.reviewAfterPublication(next.review, commit));
      const after = await refreshed.get(next.review)!;
      if (after.status !== 200) continue;
      const carried = carryChangesAfterPublication(next.review.graph, after.data.graph, receipt, next.request.componentIds,
        { allowAnotherScope: true });
      if (carried.size !== next.request.componentIds.length) continue;
      next.request = {
        ...next.request, generation: after.data.view.generation,
        componentIds: next.request.componentIds.map((id) => carried.get(id)!),
      };
      next.review = after.data;
    }
  }

  private async refuseQueued(job: DeleteJob, reason: string): Promise<void> {
    const { ledger } = this.services;
    const { projectId, jobId } = job.request;
    const key = { projectId, jobId };
    try {
      if ((await ledger.commitJob(key))?.journal.phase === "queued") await ledger.finishRecovery(key, {
        status: "refused", evidence: "not-attempted", refusal: { code: "delete-commit", reason },
      });
    } catch (error) {
      console.warn(`[changes] could not record delete commit refusal for ${job.title}`, error);
    }
  }
}
