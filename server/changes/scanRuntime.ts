import { join, resolve } from "node:path";
import type { ChangeDiff, ChangesView } from "../../shared/changes.ts";
import {
  buildChangeComponents, freezeChangeSelection, getComponentDiff,
  type ChangeComponentGraph, type ChangeComponentInput, type ChangeOwnershipReceipt,
} from "./components.ts";
import type { CommitContext, CommitTransactionPorts } from "./commitTransaction.ts";
import { sameEntry, type Entry } from "./entries.ts";
import { captureGitHead, GitPublicationError } from "./gitPublication.ts";
import { GitScanBaseChangedError, scanGitChanges, type GitScanEntry, type GitScanHead } from "./gitScan.ts";
import type { LedgerView } from "./ledger.ts";
import type { LedgerWorkerClient } from "./ledgerWorkerClient.ts";
import { evidencePath, sameHead, type LedgerProject } from "./project.ts";

const POLL_MS = 2_000;
export const REVIEW_AGAIN = "Changed meanwhile: review again";
const NO_WORKTREE = "The project folder is not in a Git worktree";
const UNSAFE_PATH = "Path cannot be observed in this project";
const MISMATCH = "The ledger and Git read different versions of this entry";

export interface ScanLedgerSource extends Pick<LedgerWorkerClient, "discover" | "observe"> {
  /** Exact repository-relative chain and pending paths, including paths absent from Git status. */
  trackedPaths(project: Readonly<LedgerProject>): Promise<readonly string[]>;
}

export interface ScanWriterSource {
  snapshot(projectId: string): Promise<ChangeComponentInput["writers"]>;
}

export type ScanGroupState = Pick<ChangeComponentInput, "closedGroups" | "notices">;

export interface ScanRuntimePorts {
  ledger: ScanLedgerSource;
  writers: ScanWriterSource;
  /** Supply lifecycle metadata for the precise served scope, including for background jobs. */
  groupState?(project: Readonly<LedgerProject>): Promise<ScanGroupState>;
  updated?(update: { project: string; generation: number; changedFiles: number }): void;
}

export type CurrentChanges =
  | { readonly kind: "none" }
  | { readonly kind: "loading"; readonly directory: string }
  | { readonly kind: "non-repository"; readonly directory: string; readonly reason: string }
  | { readonly kind: "unavailable"; readonly directory: string; readonly reason: string; readonly project?: Readonly<LedgerProject> }
  | { readonly kind: "ready"; readonly project: Readonly<LedgerProject>; readonly view: ChangesView };

export type ScanResponse<T> =
  | { readonly status: 200; readonly data: T }
  | { readonly status: 404 | 409; readonly reason: string };

export interface ScanReview {
  readonly project: Readonly<LedgerProject>;
  readonly view: ChangesView;
  readonly graph: ChangeComponentGraph;
  /** A served scope can change independently of the worktree's project id. */
  readonly isProjectCurrent: () => boolean;
  /** Use as the transaction's scanAndFreeze port. The review token stays on the server. */
  readonly scanAndFreeze: CommitTransactionPorts<ChangeOwnershipReceipt>["scanAndFreeze"];
}

interface Published {
  readonly project: Readonly<LedgerProject>;
  readonly graph: ChangeComponentGraph;
  readonly signature: string;
}

interface ActiveProject {
  readonly directory: string;
  requested: boolean;
  task?: Promise<void>;
  published?: Published;
  project?: Readonly<LedgerProject>;
  unavailable?: Extract<CurrentChanges, { kind: "non-repository" | "unavailable" }>;
  /** A scope or HEAD change revokes public reviews, even if a later scan returns to it. */
  binding?: { readonly key: string };
}

class GitScanUnavailableError extends Error {}

class ScanProjectChangedError extends GitScanUnavailableError {
  constructor() { super("The served Git project changed: review again"); }
}

function projectKey(project: Readonly<LedgerProject>): string {
  return JSON.stringify([project.id, project.root, project.gitDir, project.commonDir, project.servedDir, project.scope]);
}

function belongsToScope(project: Readonly<LedgerProject>, path: string): boolean {
  try { return path === evidencePath(project, join(project.root, path)); }
  catch { return false; }
}

function asEntry(mode: string | undefined, blob: string | null | undefined): Entry | undefined {
  if (mode === undefined) return { kind: "absent" };
  if (!blob) return undefined;
  if (mode === "120000") return { kind: "symlink", blob };
  if (mode === "100644" || mode === "100755") return { kind: "file", mode, blob };
}

function reconcile(gitEntries: GitScanEntry[], ledger: LedgerView): Pick<ChangeComponentInput, "git" | "ledger"> {
  const byPath = new Map(gitEntries.flatMap((entry) => entry.path ? [[entry.path, entry] as const] : []));
  const snapshots = new Map(ledger.snapshots.map((entry) => [entry.path, entry]));
  const matched = new Set<string>();
  for (const [path, git] of byPath) {
    if (git.otherReason) continue;
    const base = asEntry(git.base?.mode, git.base?.workingSha256);
    const current = asEntry(git.current?.mode, git.current?.sha256);
    const snapshot = snapshots.get(path);
    if (base && current && snapshot && sameEntry(base, snapshot.base) && sameEntry(current, snapshot.current)) {
      matched.add(path);
    }
  }
  const files = ledger.files.filter(({ path, base, current }) => {
    const snapshot = snapshots.get(path);
    return matched.has(path) && snapshot && sameEntry(base, snapshot.base) && sameEntry(current, snapshot.current);
  });
  // Git-clean paths are observations for the ledger. Only a corroborated move can bring one into the graph.
  const moves = new Map<string, GitScanEntry[]>();
  for (const { path, moves: ownedMoves } of files) {
    for (const move of ownedMoves) {
      const endpoints = moves.get(move) ?? [];
      endpoints.push(byPath.get(path)!);
      moves.set(move, endpoints);
    }
  }
  const included = new Set(gitEntries.filter(({ status }) => status.length));
  for (const endpoints of moves.values()) {
    if (endpoints.length !== 2 || !endpoints.some(({ status }) => status.length)) continue;
    for (const endpoint of endpoints) included.add(endpoint);
  }
  const entries = gitEntries.filter((entry) => included.has(entry)).map((entry) =>
    entry.otherReason || (entry.path && matched.has(entry.path)) ? entry : { ...entry, otherReason: MISMATCH });
  return { git: { entries }, ledger: { ...ledger, files } };
}

function isHeadChange(error: unknown): boolean {
  return error instanceof GitScanBaseChangedError ||
    (error instanceof Error && error.message === "Git HEAD moved while updating the source-control ledger");
}

export function isGitScanUnavailable(error: unknown): boolean {
  return error instanceof GitScanUnavailableError || isHeadChange(error);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ScanRuntime {
  private active?: ActiveProject;
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;
  private readonly scans = new Map<string, Promise<void>>();
  private readonly statusListeners = new Set<() => void>();

  constructor(private readonly ports: ScanRuntimePorts) {}

  status(): CurrentChanges {
    const active = this.active;
    if (!active) return { kind: "none" };
    const published = active.published;
    if (published) return { kind: "ready", project: published.project, view: published.graph.view };
    return active.unavailable ?? { kind: "loading", directory: active.directory };
  }

  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private notifyStatus(): void {
    for (const listener of this.statusListeners) {
      try { listener(); }
      catch (error) { console.warn("[changes] source-control status listener failed", error); }
    }
  }

  setProject(directory: string | null): Promise<void> {
    const previous = this.active;
    if (directory === null) this.active = undefined;
    else {
      const absolute = resolve(directory);
      if (absolute !== this.active?.directory) this.active = { directory: absolute, requested: false };
    }
    if (previous !== this.active) this.notifyStatus();
    return this.refresh();
  }

  setVisible(visible: boolean): Promise<void> {
    if (visible === (this.timer !== undefined)) return Promise.resolve();
    if (!visible) {
      clearInterval(this.timer);
      this.timer = undefined;
      return Promise.resolve();
    }
    this.timer = setInterval(() => { void this.refresh(); }, POLL_MS);
    this.timer.unref();
    return this.refresh();
  }

  focus(): Promise<void> { return this.refresh(); }

  /** Coalesce ledger notifications received together or during a scan into at most one pending scan. */
  ledgerChanged(projectId: string): void {
    const activeProject = this.active?.project;
    if (!activeProject || activeProject.id === projectId) void this.refresh();
  }

  refresh(): Promise<void> {
    const active = this.active;
    if (!active) return Promise.resolve();
    active.requested = true;
    active.task ??= Promise.resolve().then(async () => {
      try {
        while (this.active === active && active.requested) {
          active.requested = false;
          await this.publishCurrent(active);
          if (this.active === active) this.notifyStatus();
        }
      } finally {
        active.task = undefined;
      }
    });
    return active.task;
  }

  snapshot(projectId: string): ScanResponse<ChangesView> {
    const current = this.active?.published;
    if (!current || current.project.id !== projectId) return { status: 409, reason: REVIEW_AGAIN };
    return { status: 200, data: current.graph.view };
  }

  diff(projectId: string, generation: number, component: string, path: string): ScanResponse<ChangeDiff> {
    const current = this.active?.published;
    if (!current || current.project.id !== projectId || current.graph.view.generation !== generation) {
      return { status: 409, reason: REVIEW_AGAIN };
    }
    const diff = getComponentDiff(current.graph, component, path);
    return diff ? { status: 200, data: diff } : { status: 404, reason: "The component does not contain this path" };
  }

  reviewCurrent(projectId: string, generation: number): ScanResponse<ScanReview> {
    const active = this.active;
    const current = active?.published;
    if (!active || !current || current.project.id !== projectId || current.graph.view.generation !== generation) {
      return { status: 409, reason: REVIEW_AGAIN };
    }
    const binding = active.binding;
    return { status: 200, data: this.review(current.project, current.graph,
      () => this.active === active && active.binding === binding && active.published !== undefined,
      () => this.active === active && active.project !== undefined && projectKey(active.project) === projectKey(current.project)) };
  }

  /** Recovery and stop actions must also work when a commit pin prevents publishing a scan. */
  projectContext(projectId: string, generation?: number): ScanResponse<{
    project: Readonly<LedgerProject>;
    isCurrent: () => boolean;
  }> {
    const active = this.active;
    const project = active?.project;
    if (!active || !project || project.id !== projectId) return { status: 409, reason: REVIEW_AGAIN };
    const isCurrent = () => this.active === active && active.project !== undefined &&
      projectKey(active.project) === projectKey(project) &&
      (generation === undefined || active.published?.graph.view.generation === generation);
    return isCurrent() ? { status: 200, data: { project, isCurrent } } : { status: 409, reason: REVIEW_AGAIN };
  }

  /** Follow only a commit just published by this request, with the same active project and branch. */
  async reviewAfterPublication(review: ScanReview, commit: string): Promise<ScanResponse<ScanReview>> {
    const { project, isProjectCurrent } = review;
    if (!isProjectCurrent()) return { status: 409, reason: REVIEW_AGAIN };
    try {
      const input = await this.serialize(project, () => this.scan(project, { branch: review.view.branch, oid: commit }));
      if (!isProjectCurrent()) return { status: 409, reason: REVIEW_AGAIN };
      const graph = buildChangeComponents({ ...input, generation: ++this.generation });
      return { status: 200, data: this.review(project, graph, isProjectCurrent, isProjectCurrent) };
    } catch (error) {
      const reason = isHeadChange(error) || error instanceof ScanProjectChangedError ? REVIEW_AGAIN : String(error);
      return { status: 409, reason };
    }
  }

  /** The caller must supply the server-owned descriptor pinned to the writer or job. */
  async reviewProject(project: Readonly<LedgerProject>): Promise<ScanReview> {
    const pinned = Object.freeze({ ...project });
    const input = await this.serialize(pinned, () => this.scan(pinned));
    const graph = buildChangeComponents({ ...input, generation: ++this.generation });
    return this.review(pinned, graph, () => true);
  }

  private review(project: Readonly<LedgerProject>, graph: ChangeComponentGraph, active: () => boolean, isProjectCurrent = active): ScanReview {
    const { review: token, view } = graph;
    return Object.freeze({
      project, view, graph, isProjectCurrent,
      scanAndFreeze: async (context: CommitContext) => {
        const { request, head } = context;
        if (!active() || context.project.id !== project.id || context.project.root !== project.root ||
            context.project.commonDir !== project.commonDir || context.indexPath !== join(project.gitDir, "index") ||
            request.projectId !== project.id || request.generation !== token.generation ||
            !sameHead(head, { branch: view.branch, oid: view.base })) return null;
        try {
          const input = await this.serialize(project, () => this.scan(project, head));
          if (!active()) return null;
          const fresh = buildChangeComponents({ ...input, generation: token.generation });
          return freezeChangeSelection(token, fresh, request);
        } catch (error) {
          if (isHeadChange(error) || error instanceof ScanProjectChangedError) return null;
          throw error;
        }
      },
    });
  }

  private serialize<T>(project: Readonly<LedgerProject>, scan: () => Promise<T>): Promise<T> {
    // Scopes in a worktree share the ledger. Order their observations while Git I/O runs asynchronously.
    const task = (this.scans.get(project.id) ?? Promise.resolve()).then(scan);
    const barrier = task.then(() => {}, () => {});
    this.scans.set(project.id, barrier);
    void barrier.then(() => {
      if (this.scans.get(project.id) === barrier) this.scans.delete(project.id);
    });
    return task;
  }

  private async publishCurrent(active: ActiveProject): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const found = await this.ports.ledger.discover(active.directory);
        if (this.active !== active) return;
        if (!found.project) {
          active.binding = undefined;
          active.published = undefined;
          active.project = undefined;
          active.unavailable = {
            kind: found.reason === NO_WORKTREE ? "non-repository" : "unavailable",
            directory: active.directory, reason: found.reason,
          };
          return;
        }
        const project = Object.freeze({ ...found.project });
        active.project = project;
        const binding = projectKey(project);
        if (active.binding?.key !== binding) {
          active.binding = { key: binding };
          active.published = undefined;
        }
        active.unavailable = undefined;
        const input = await this.serialize(project, () => this.scan(project));
        if (this.active !== active) return;
        const previous = active.published;
        const moved = previous && !sameHead(input.head, {
          branch: previous.graph.view.branch, oid: previous.graph.view.base,
        });
        // The ledger distinguishes external moves from Vizzo's settled publications.
        const graph = buildChangeComponents({ ...input, generation: this.generation + 1 });
        const { generation, ...view } = graph.view;
        const signature = JSON.stringify(view);
        if (signature === previous?.signature) return;
        if (moved) active.binding = { key: binding };
        this.generation = generation;
        active.published = { project, graph, signature };
        this.ports.updated?.({ project: project.id, generation, changedFiles: graph.view.changedFiles });
        return;
      } catch (error) {
        if (this.active !== active) return;
        active.published = undefined;
        active.binding = undefined;
        if ((isHeadChange(error) || error instanceof ScanProjectChangedError) && attempt === 0) continue;
        active.unavailable = { kind: "unavailable", directory: active.directory, reason: reason(error), project: active.project };
        return;
      }
    }
  }

  private async assertProject(project: Readonly<LedgerProject>): Promise<void> {
    const found = await this.ports.ledger.discover(project.servedDir);
    if (!found.project || projectKey(found.project) !== projectKey(project)) throw new ScanProjectChangedError();
  }

  private async head(project: Readonly<LedgerProject>): Promise<GitScanHead> {
    try { return await captureGitHead(project.root); }
    catch (error) {
      if (!(error instanceof GitPublicationError) || error.code !== "detached-head") {
        throw new GitScanUnavailableError(reason(error), { cause: error });
      }
      const { head } = await this.ports.ledger.observe(project, []);
      if (head.branch !== null) throw new GitScanBaseChangedError();
      return head;
    }
  }

  private async scan(project: Readonly<LedgerProject>, captured?: GitScanHead): Promise<Omit<ChangeComponentInput, "generation">> {
    await this.assertProject(project);
    const head = captured ?? await this.head(project);
    const scope = { worktreeRoot: project.root, projectDir: project.scope };
    const tracked = (await this.ports.ledger.trackedPaths(project)).filter((path) => belongsToScope(project, path));
    const git = await scanGitChanges(scope, head, tracked).catch((error: unknown) => {
      if (isHeadChange(error)) throw error;
      throw new GitScanUnavailableError(reason(error), { cause: error });
    });
    const paths = new Set(tracked);
    for (const entry of git.entries) {
      if (entry.path && belongsToScope(project, entry.path)) paths.add(entry.path);
      else if (entry.path) entry.otherReason ??= UNSAFE_PATH;
    }
    const ledger = await this.ports.ledger.observe(project, [...paths]);
    if (!sameHead(ledger.head, head)) throw new GitScanBaseChangedError();
    const [writers, groupState] = await Promise.all([
      this.ports.writers.snapshot(project.id),
      this.ports.groupState?.(project),
    ]);
    await this.assertProject(project);
    if (!sameHead(head, await this.head(project))) throw new GitScanBaseChangedError();
    const grokInScope = writers.executions.some(({ harness, folder }) => harness === "grok" &&
      (folder === project.servedDir || folder === project.scope));
    return { ...groupState, projectId: project.id, scope, head, writers, grokInScope, ...reconcile(git.entries, ledger) };
  }
}
