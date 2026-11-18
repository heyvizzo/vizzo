import { relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { combine } from "./annotations.ts";
import { boundVersions, changeBase, compact, insert, inspect, newChain, observe, place, tip, type Chain, type FileEvidence } from "./chain.ts";
import { CommitOwnershipError, pinCommitOwnership, settleCommitOwnership, validateCommitOwnershipCandidate, verifyLateCommitEdit,
  type CommitOwnershipPlan, type CommitOwnershipReceipt,
  type CommitOwnershipSnapshot, type PublishedBaseEvidence } from "./commitOwnership.ts";
import type { CommitRecoveryCheckpoint, CommitRecoveryResult } from "./commitRecovery.ts";
import type { CommitJournal, CommitProject, CommitRequest, CommitStart, FrozenCommitSelection } from "./commitTransaction.ts";
import { changeWriterId } from "./components.ts";
import { bytesFor, sameEntry, storeEntry, type Content, type Entry, type ReadEntry } from "./entries.ts";
import { batchKey, exactBytes, exactText, MAX_FILE_BYTES, parsePatch, PENDING_MS, TOO_LARGE,
  type EditBatch, type EditChange } from "./evidence.ts";
import { hash, LedgerPersistence } from "./persistence.ts";
import { evidencePath, pathAcceptsEvidence, readBaseEntry, readLedgerHead, readWorkingEntry, sameHead,
  type LedgerHead, type LedgerProject } from "./project.ts";
import { stopVerifiedOrphanNativeProcess } from "../adapters/nativeProcess.ts";
import type { ProjectWriterSnapshot, WriterExecutionRecord } from "./writers.ts";

interface Effect {
  path: string;
  evidence: FileEvidence;
}
type Unit = [Effect] | [Effect, Effect];

type Result = "applied" | "pending" | "expired" | "rejected";
interface Receipt {
  executionId: string;
  sessionId: string;
  toolCallId: string;
  outcome: EditBatch["outcome"];
  expiresAt: number;
  results: Result[];
  pending: { index: number; effects: Unit }[];
  reason?: string;
  held?: { receivedAt: number; head?: LedgerHead; observed?: Record<string, Entry> };
}

type RecoveryOutcome = Exclude<CommitRecoveryResult, { status: "skipped" }>;
type TerminalPhase = "done" | "refused" | "not-published";
type JobFields = { project: CommitProject; request: CommitRequest; pid: number };
type QueuedCommit = JobFields & { phase: "queued" };
type RecoveredCommit = JobFields & { phase: TerminalPhase };
type CommitProgress = CommitJournal<CommitOwnershipPlan>;

interface StoredBaseEvidence {
  commit: string;
  paths: { path: string; raw: string | null; working: Entry }[];
}

export interface CommitJobRecord {
  version: 1;
  project: LedgerProject;
  journal: QueuedCommit | CommitProgress | RecoveredCommit;
  pin?: CommitOwnershipPlan;
  prepared?: StoredBaseEvidence;
  recovery?: CommitRecoveryCheckpoint | null;
  outcome?: RecoveryOutcome;
  issue?: string;
}

export interface CommitJobKey {
  projectId: string;
  jobId: string;
}

export type CommitJobSummary = Pick<CommitJobRecord, "version" | "project" | "outcome"> & {
  jobId: string;
  phase: CommitJobRecord["journal"]["phase"];
  commit?: string;
  reason?: string;
  status: "queued" | "committing" | "done" | "refused" | "not-published" | "indeterminate" | "repair-needed" | "blocked";
  canFix: boolean;
};

interface ProjectState {
  head: LedgerHead;
  headMoved: boolean;
  files: Record<string, Chain>;
  receipts: Record<string, Receipt>;
  executions: Record<string, LedgerProject>;
  moves: Record<string, readonly [string, string]>;
  notices: Record<string, string>;
  writerRecords?: Record<string, WriterExecutionRecord>;
  commitJobs?: Record<string, CommitJobRecord>;
  pinnedJob?: string;
}

export interface BatchResult {
  duplicate: boolean;
  results: readonly Result[];
  reason?: string;
}

export type LedgerFile = ReturnType<typeof inspect>;
export interface LedgerView {
  head: LedgerHead;
  headMoved: boolean;
  files: LedgerFile[];
  /** SHA-256 of the exact working bytes in file and symlink entries, including unchanged paths. */
  snapshots: { path: string; base: Entry; current: Entry }[];
}

function fileKey(path: string): string { return "/" + path; }
function executionKey(id: string): string { return JSON.stringify(id); }
function caseKey(path: string): string { return path.normalize("NFC").toUpperCase().normalize("NFC"); }

function newState(head: LedgerHead): ProjectState {
  return { head, headMoved: false, files: {}, receipts: {}, executions: {}, moves: {}, notices: {} };
}

function blobIds(state: ProjectState): Set<string> {
  const result = new Set<string>();
  for (const chain of Object.values(state.files)) {
    for (const entry of [chain.base, ...chain.versions.map((version) => version.entry)]) {
      if (entry.kind === "file" || entry.kind === "symlink") result.add(entry.blob);
    }
  }
  for (const receipt of Object.values(state.receipts)) {
    for (const { effects } of receipt.pending) {
      for (const { evidence } of effects) {
        if ("patch" in evidence) result.add(evidence.patch);
        else {
          if (evidence.from) result.add(evidence.from);
          if (evidence.to) result.add(evidence.to);
        }
      }
    }
  }
  const pinned = state.pinnedJob === undefined ? undefined : state.commitJobs?.[state.pinnedJob];
  for (const { raw, working } of pinned?.prepared?.paths ?? []) {
    if (raw) result.add(raw);
    if (working.kind === "file" || working.kind === "symlink") result.add(working.blob);
  }
  return result;
}

class InvalidEvidence extends Error {}

function inputBytes(value: unknown): Buffer | null {
  if (value === null) return null;
  const bytes = exactBytes(value);
  if (!bytes) throw new InvalidEvidence("Malformed exact edit bytes");
  return bytes;
}

function uniquePaths(units: Unit[]): string[] {
  return [...new Set(units.flatMap((unit) => unit.map(({ path }) => path)))];
}

function normalizeChanges(project: LedgerProject, changes: readonly EditChange[], content: Content): Unit[] {
  const projectPath = (path: string): string => {
    try { return evidencePath(project, path); }
    catch (error) { throw new InvalidEvidence(error instanceof Error ? error.message : String(error)); }
  };
  if (!changes.length) throw new InvalidEvidence("An edit batch must contain a change");
  let eventBytes = 0;
  const seen = new Set<string>();
  const put = (bytes: Buffer | null): string | null => {
    if (bytes === null) return null;
    eventBytes += bytes.length;
    if (eventBytes > MAX_FILE_BYTES) throw new InvalidEvidence(TOO_LARGE);
    return content.put(bytes);
  };
  return changes.map((change) => {
    const path = projectPath(change.path);
    const folded = caseKey(path);
    if (seen.has(folded)) throw new InvalidEvidence("Edit paths collide");
    seen.add(folded);
    if ("move" in change) {
      const destination = projectPath(change.move.path);
      const destKey = caseKey(destination);
      const before = inputBytes(change.from);
      const destBefore = inputBytes(change.move.from);
      const destAfter = inputBytes(change.move.to);
      if (path === destination || (destKey !== folded && seen.has(destKey)) || before === null ||
          change.to !== null || destAfter === null || (destKey === folded && destBefore !== null)) {
        throw new InvalidEvidence("Move does not prove distinct source and destination entries");
      }
      seen.add(destKey);
      return [
        { path, evidence: { from: put(before), to: null } },
        { path: destination, evidence: { from: put(destBefore), to: put(destAfter) } },
      ];
    }
    if ("patch" in change) {
      if (!exactText(change.patch) || (change.to !== undefined && change.to !== null)) throw new InvalidEvidence("Malformed exact patch");
      const bytes = Buffer.from(change.patch);
      if (bytes.length > MAX_FILE_BYTES) throw new InvalidEvidence(TOO_LARGE);
      if (!parsePatch(change.path, change.patch)) throw new InvalidEvidence("Patch lacks exact preimage evidence");
      return [{ path, evidence: { patch: put(bytes)!, patchPath: change.path, deletion: change.to === null } }];
    }
    const from = inputBytes(change.from);
    const to = inputBytes(change.to);
    if (from === null && to === null) throw new InvalidEvidence("Edit lacks an existing or created entry");
    return [{ path, evidence: { from: put(from), to: put(to) } }];
  });
}

function setPendingResult(receipt: Receipt, index: number, result: Result): void {
  receipt.results[index] = result;
  receipt.pending = receipt.pending.filter((unit) => unit.index !== index);
}

function expire(state: ProjectState, now: number, paths?: Set<string>): boolean {
  let changed = false;
  for (const receipt of Object.values(state.receipts)) {
    if (receipt.held) continue;
    for (const { index, effects } of receipt.pending) {
      if (now >= receipt.expiresAt || effects.some(({ path }) => paths?.has(path))) {
        setPendingResult(receipt, index, "expired");
        changed = true;
      }
    }
  }
  return changed;
}

function applyPending(state: ProjectState, content: Content): void {
  let changed: boolean;
  do {
    changed = false;
    for (const [key, receipt] of Object.entries(state.receipts)) {
      if (receipt.held) continue;
      for (const { index, effects } of receipt.pending) {
        const project = state.executions[executionKey(receipt.executionId)]!;
        let safe: boolean;
        try {
          safe = effects.every(({ path }, effectIndex) => pathAcceptsEvidence(project, path, effects[1 - effectIndex]?.path));
        } catch {
          safe = false;
        }
        if (!safe) {
          setPendingResult(receipt, index, "rejected");
          continue;
        }
        const placements = effects.map(({ path, evidence }) => place(state.files[fileKey(path)]!, evidence, content));
        if (placements.includes("ambiguous")) {
          setPendingResult(receipt, index, "rejected");
          receipt.reason = "Patch matches more than one recorded preimage";
          continue;
        }
        if (placements.includes("too-large")) {
          for (const { path } of effects) state.notices[fileKey(path)] = TOO_LARGE;
          setPendingResult(receipt, index, "rejected");
          receipt.reason = TOO_LARGE;
          continue;
        }
        if (placements.some((placement) => placement === undefined)) continue;
        const move = effects[1] ? JSON.stringify(["move", key, index]) : undefined;
        if (move) state.moves[move] = [effects[0].path, effects[1]!.path];
        effects.forEach(({ path }, effectIndex) => {
          const placement = placements[effectIndex]!;
          if (typeof placement === "string") throw new Error("Invalid placement");
          insert(state.files[fileKey(path)]!, placement, {
            executionId: receipt.executionId, key: JSON.stringify([key, path]), move,
          });
        });
        setPendingResult(receipt, index, "applied");
        changed = true;
      }
    }
  } while (changed);
}

function boundAll(state: ProjectState, content: Content): void {
  const overflow = new Set<string>();
  for (const [key, chain] of Object.entries(state.files)) {
    if (boundVersions(chain, content)) overflow.add(key.slice(1));
  }
  if (overflow.size) expire(state, -Infinity, overflow);
}

function normalizeTip(state: ProjectState, key: string): void {
  const chain = state.files[key];
  if (chain && sameEntry(chain.base, tip(chain)) &&
      !Object.values(state.receipts).some((receipt) => receipt.pending.some(({ effects }) =>
        effects.some(({ path }) => fileKey(path) === key)))) {
    delete state.files[key];
  }
}

function cleanMoves(state: ProjectState): void {
  for (const [move, endpoints] of Object.entries(state.moves)) {
    const represented = endpoints.some((path) => {
      const chain = state.files[fileKey(path)];
      return chain && (chain.anchor.moves.includes(move) || chain.versions.some(({ link }) => link?.move === move));
    });
    if (!represented) delete state.moves[move];
  }
}

function wholeWorktree(project: LedgerProject): LedgerProject {
  return { ...project, servedDir: project.root, scope: project.root };
}

function jobKey(id: string): string { return JSON.stringify(id); }

function isTerminal({ phase }: CommitJobRecord["journal"]): boolean {
  return phase === "done" || phase === "not-published" || phase === "refused";
}

function currentJob(state: ProjectState | undefined, key: string): CommitJobRecord | undefined {
  const record = state?.commitJobs?.[key];
  if (record && record.version !== 1) throw new Error("Unsupported source-control commit journal");
  return record;
}

function jobReason({ journal, outcome, issue }: CommitJobRecord): string | undefined {
  if (issue) return issue;
  if (outcome) return "message" in outcome ? outcome.message : "refusal" in outcome ? outcome.refusal.reason : undefined;
  if ("reason" in journal) return journal.reason;
  if ("refusal" in journal) return journal.refusal?.reason;
}

function summarizeJob(job: CommitJobRecord): CommitJobSummary {
  const { version, project, journal, outcome } = job;
  const repair = journal.phase === "index-ready" && journal.step === "repair";
  const status = outcome?.status ?? (repair ? "repair-needed" :
    journal.phase === "index-ready" || journal.phase === "publishing" || journal.phase === "locking" ? "committing" : journal.phase);
  return {
    version, project, jobId: journal.request.jobId, phase: journal.phase, status: job.issue ? "blocked" : status,
    outcome, reason: jobReason(job),
    commit: "commit" in journal ? journal.commit : outcome && "commit" in outcome ? outcome.commit : undefined,
    canFix: !!job.issue || (outcome ? "canFix" in outcome && outcome.canFix : repair),
  };
}

function assertUnpinned(state: ProjectState): void {
  if (state.pinnedJob === undefined) return;
  const job = currentJob(state, state.pinnedJob);
  if (!job) throw new Error("The source-control commit pin has no journal");
  throw new Error(jobReason(job) ?? "Vizzo is settling a source-control commit for this project");
}

function rebaseState(
  state: ProjectState, project: LedgerProject, head: LedgerHead, content: Content, except = new Set<string>(),
): void {
  const scoped = wholeWorktree(project);
  const changed = Object.entries(state.files).flatMap(([key, chain]) => {
    const path = key.slice(1);
    if (except.has(path)) return [];
    const base = storeEntry(readBaseEntry(scoped, path, head), content);
    return sameEntry(base, chain.base) ? [] : [{ path, chain, base }];
  });
  for (const { chain, base } of changed) changeBase(chain, base, content);
  expire(state, -Infinity, new Set(changed.map(({ path }) => path)));
  for (const { path } of changed) normalizeTip(state, fileKey(path));
  state.head = head;
}

function pendingPaths(state: ProjectState): Set<string> {
  return new Set(Object.values(state.receipts).flatMap((receipt) =>
    receipt.held ? [] : uniquePaths(receipt.pending.map(({ effects }) => effects))));
}

function ownershipSnapshot(state: ProjectState, project: LedgerProject): CommitOwnershipSnapshot {
  return {
    projectId: project.id, scope: { worktreeRoot: project.root, projectDir: project.scope }, head: state.head,
    chains: new Map(Object.entries(state.files).map(([key, chain]) => [key.slice(1), chain])),
    pendingPaths: pendingPaths(state),
  };
}

function addReceiptPaths(state: ProjectState, receipt: Receipt, content: Content): void {
  const project = wholeWorktree(state.executions[executionKey(receipt.executionId)]!);
  for (const path of uniquePaths(receipt.pending.map(({ effects }) => effects))) {
    state.files[fileKey(path)] ??= newChain(storeEntry(readBaseEntry(project, path, state.head), content), content);
  }
}

function matchesReport(entry: Entry, blob: string | null): boolean {
  return blob === null ? entry.kind === "absent" : entry.kind === "file" && entry.blob === blob;
}

function observeHeldRollbacks(state: ProjectState, project: LedgerProject, units: Unit[]): Record<string, Entry> {
  const observed: Record<string, Entry> = {};
  for (const [effect, next] of units) {
    const { path, evidence } = effect;
    if (next || "patch" in evidence) continue;
    const chain = state.files[fileKey(path)];
    if (!chain || matchesReport(tip(chain), evidence.from) ||
        !chain.versions.some(({ entry }) => matchesReport(entry, evidence.from))) continue;
    let current: ReadEntry;
    try { current = readWorkingEntry(project, path); }
    catch { continue; }
    if (current.kind === "absent" && evidence.to === null) observed[fileKey(path)] = current;
    if (current.kind === "file" && hash(current.bytes) === evidence.to) {
      // Normalizing the report already stored and fsynced these exact bytes.
      observed[fileKey(path)] = { kind: "file", mode: current.mode, blob: evidence.to };
    }
  }
  return observed;
}

function acceptsHeldPath(state: ProjectState, receipt: Receipt, path: string): boolean {
  try { return pathAcceptsEvidence(state.executions[executionKey(receipt.executionId)]!, path); }
  catch { return false; }
}

function explainFrozenGaps(
  state: ProjectState, plan: CommitOwnershipPlan, nextHead: LedgerHead, content: Content,
): CommitOwnershipPlan {
  const selected = new Set(plan.paths.map(({ path }) => path));
  for (const [key, receipt] of Object.entries(state.receipts)) {
    if (!receipt.held) continue;
    const { head } = receipt.held;
    if (!head || (!sameHead(head, state.head) && !sameHead(head, nextHead))) break;
    for (const { index, effects: [{ path, evidence }, second] } of receipt.pending) {
      if (second || !selected.has(path) || !acceptsHeldPath(state, receipt, path)) continue;
      const chain = structuredClone(state.files[fileKey(path)]!);
      const placement = place(chain, evidence, content);
      if (placement === "ambiguous") {
        setPendingResult(receipt, index, "rejected");
        receipt.reason = "Patch matches more than one recorded preimage";
        continue;
      }
      if (!placement || placement === "too-large" || (placement.rejoin === undefined && placement.reconnect === undefined)) continue;
      insert(chain, placement, { executionId: receipt.executionId, key: JSON.stringify([key, path]) });
      const verified = verifyLateCommitEdit(plan, path, chain, content);
      if (!verified) continue;
      plan = verified;
      state.files[fileKey(path)] = chain;
      setPendingResult(receipt, index, "applied");
    }
  }
  return plan;
}

function reconnectHeldRollbacks(
  state: ProjectState, key: string, receipt: Receipt, observed: Record<string, Entry>,
  previous: ReadonlyMap<string, Chain>, content: Content,
): void {
  for (const { index, effects: [{ path, evidence }, second] } of receipt.pending) {
    const endpoint = observed[fileKey(path)];
    const original = previous.get(path);
    const current = state.files[fileKey(path)];
    if (second || "patch" in evidence || !endpoint || !current || !acceptsHeldPath(state, receipt, path)) continue;
    if (!original) {
      observe(current, endpoint);
      continue;
    }
    if (!sameEntry(current.versions[0]!.entry, tip(original)) || sameEntry(tip(current), endpoint)) continue;
    const witness = structuredClone(original);
    observe(witness, endpoint);
    const placement = place(witness, evidence, content);
    if (!placement || typeof placement === "string" || placement.reconnect !== witness.versions.length - 1 ||
        !sameEntry(placement.after, endpoint)) continue;
    const preimage = witness.versions[placement.from]!.entry;
    // The intervening return to the historical preimage is an unexplained gap.
    if (!sameEntry(tip(current), preimage)) current.versions.push({ entry: preimage });
    const from = current.versions.length - 1;
    observe(current, endpoint);
    insert(current, { from, after: endpoint, rejoin: current.versions.length - 1 }, {
      executionId: receipt.executionId, key: JSON.stringify([key, path]),
    });
    setPendingResult(receipt, index, "applied");
  }
}

function replayHeld(
  state: ProjectState, project: LedgerProject, before: LedgerHead, settled: LedgerHead,
  previous: ReadonlyMap<string, Chain>, content: Content,
): void {
  let frozenHistory = previous;
  for (const [key, receipt] of Object.entries(state.receipts)) {
    const held = receipt.held;
    if (!held) continue;
    expire(state, held.receivedAt);
    delete receipt.held;
    if (!held.head) {
      frozenHistory = new Map();
      for (const { index } of receipt.pending) setPendingResult(receipt, index, "expired");
      receipt.reason = "Git HEAD was unavailable when the edit arrived";
      continue;
    }
    const head = sameHead(before, held.head) ? settled : held.head;
    if (!sameHead(state.head, head)) {
      frozenHistory = new Map();
      rebaseState(state, project, head, content);
      state.headMoved = true;
    }
    addReceiptPaths(state, receipt, content);
    if (held.observed && sameHead(state.head, settled)) {
      reconnectHeldRollbacks(state, key, receipt, held.observed, frozenHistory, content);
    }
    applyPending(state, content);
    boundAll(state, content);
  }
  expire(state, Date.now());
}

/** Owned exclusively by the ledger worker. Each synchronous operation replaces the journal at most once. */
export class LedgerStore {
  private readonly persistence: LedgerPersistence<ProjectState>;
  private readonly onExpired?: (projectId: string) => void;

  constructor(persistence = new LedgerPersistence<ProjectState>(), onExpired?: (projectId: string) => void) {
    this.persistence = persistence;
    this.onExpired = onExpired;
  }

  private loadProject(project: LedgerProject) {
    this.persistence.assertExternal(project.id, [project.root, project.gitDir, project.commonDir]);
    const all = this.persistence.load();
    const state = all[project.id] ?? newState(readLedgerHead(project));
    const content = this.persistence.content(project.id);
    const save = () => this.saveProject(all, project.id, state);
    return { state, content, all, save };
  }

  private saveProject(all: Record<string, ProjectState>, projectId: string, state: ProjectState): void {
    cleanMoves(state);
    all[projectId] = state;
    this.persistence.save(all);
    this.persistence.content(projectId).prune(blobIds(state));
  }

  private open(project: LedgerProject, now: number, allowPinned = false) {
    const loaded = this.loadProject(project);
    const { state, content } = loaded;
    if (state.pinnedJob !== undefined && allowPinned) return loaded;
    assertUnpinned(state);
    const head = readLedgerHead(project);
    expire(state, now);
    if (!sameHead(state.head, head)) {
      rebaseState(state, project, head, content);
      state.headMoved = true;
    }
    const save = () => {
      if (!sameHead(state.head, readLedgerHead(project))) throw new Error("Git HEAD moved while updating the source-control ledger");
      loaded.save();
    };
    return { ...loaded, save };
  }

  ingest(project: LedgerProject, batch: EditBatch, now = Date.now()): BatchResult {
    const key = batchKey(batch);
    const { state, content, all, save } = this.open(project, now, true);
    const id = executionKey(batch.executionId);
    for (const candidate of [state, ...Object.values(all)]) {
      const pinned = candidate.executions[id];
      if (pinned && (pinned.id !== project.id || pinned.gitDir !== project.gitDir ||
          pinned.scope !== project.scope || pinned.servedDir !== project.servedDir)) throw new Error("Execution project scope changed");
    }
    const prior = state.receipts[key];
    if (prior) {
      save();
      return { duplicate: true, results: prior.results, reason: prior.reason };
    }
    state.executions[id] = project;
    const receipt: Receipt = {
      executionId: batch.executionId, sessionId: batch.sessionId, toolCallId: batch.toolCallId,
      outcome: batch.outcome, expiresAt: now + PENDING_MS, results: [], pending: [],
    };
    state.receipts[key] = receipt;
    if (batch.outcome === "completed") {
      let units: Unit[] = [];
      try {
        units = normalizeChanges(project, batch.changes, content);
      } catch (error) {
        if (!(error instanceof InvalidEvidence)) throw error;
        receipt.reason = error.message;
        receipt.results = batch.changes.map(() => "rejected");
        if (receipt.reason === TOO_LARGE) {
          for (const change of batch.changes) {
            try { state.notices[fileKey(evidencePath(project, change.path))] = TOO_LARGE; } catch { /* outside scope */ }
          }
        }
      }
      for (const [index, effects] of units.entries()) {
        receipt.results.push("pending");
        receipt.pending.push({ index, effects });
      }
      if (state.pinnedJob !== undefined) {
        if (units.length) {
          receipt.held = { receivedAt: now };
          try {
            const scope = wholeWorktree(project);
            const head = readLedgerHead(scope);
            receipt.held.head = head;
            const observed = observeHeldRollbacks(state, project, units);
            if (Object.keys(observed).length) {
              if (sameHead(head, readLedgerHead(scope))) receipt.held.observed = observed;
              else delete receipt.held.head;
            }
          }
          catch { /* Preserve exact bytes and the unavailable base in the durable receipt. */ }
        }
      } else {
        addReceiptPaths(state, receipt, content);
        applyPending(state, content);
        boundAll(state, content);
      }
    }
    save();
    return { duplicate: false, results: receipt.results, reason: receipt.reason };
  }

  /** Read explicitly listed scan paths as observations. This never supplies tool event evidence. */
  observe(project: LedgerProject, paths: readonly string[], now = Date.now()): LedgerView {
    const { state, content, save } = this.open(project, now);
    const observed = new Map<string, ReturnType<typeof storeEntry>>();
    for (const path of new Set(paths)) {
      const key = fileKey(path);
      const entry = storeEntry(readWorkingEntry(project, path), content);
      const chain = state.files[key] ??= newChain(storeEntry(readBaseEntry(project, path, state.head), content), content);
      observed.set(key, entry);
      observe(chain, entry);
      if (entry.kind !== "opaque") delete state.notices[key];
    }
    applyPending(state, content);
    const snapshots: LedgerView["snapshots"] = [];
    for (const [key, entry] of observed) {
      const chain = state.files[key]!;
      observe(chain, entry);
      snapshots.push({ path: key.slice(1), base: chain.base, current: entry });
    }
    boundAll(state, content);
    for (const key of observed.keys()) normalizeTip(state, key);
    const result = this.view(state, content, new Set(paths), snapshots);
    save();
    return result;
  }

  private view(state: ProjectState, content: Content, paths: Set<string>, snapshots: LedgerView["snapshots"]): LedgerView {
    const files: LedgerFile[] = [];
    for (const path of paths) {
      const key = fileKey(path);
      const chain = state.files[key];
      if (!chain) continue;
      const file = inspect(chain, path, content);
      const reason = state.notices[key];
      if (reason) {
        file.hunks.push({ kind: "opaque", ownership: { owners: [null], ties: [] }, reason });
      }
      if (file.hunks.length) files.push(file);
    }
    const byPath = new Map(files.map((file) => [file.path, file]));
    for (const file of files) {
      for (const move of file.moves) {
        const endpoints = state.moves[move];
        if (endpoints?.every((endpoint) => byPath.get(endpoint)?.moves.includes(move))) continue;
        for (const hunk of file.hunks) hunk.ownership = combine([hunk.ownership, { owners: [null], ties: [] }]);
      }
    }
    return { head: state.head, headMoved: state.headMoved, files, snapshots };
  }

  /** A quiescent file can discard old witnesses once no receipt is waiting for that path. */
  compact(project: LedgerProject, paths: readonly string[], now = Date.now()): void {
    const { state, content, save } = this.open(project, now);
    const pending = pendingPaths(state);
    for (const path of paths) {
      const chain = state.files[fileKey(path)];
      if (chain && !pending.has(path)) compact(chain, content);
    }
    save();
  }

  trackedPaths(project: LedgerProject): string[] {
    const { state } = this.loadProject(project);
    assertUnpinned(state);
    const prefix = relative(project.root, project.scope);
    return [...new Set([...Object.keys(state.files), ...Object.keys(state.notices)])]
      .map((key) => key.slice(1))
      .filter((path) => !prefix || path.startsWith(prefix + sep))
      .sort();
  }

  queueCommit(project: LedgerProject, request: CommitRequest): boolean {
    const { state, save } = this.loadProject(project);
    const key = jobKey(request.jobId);
    if (request.projectId !== project.id || currentJob(state, key)) return false;
    (state.commitJobs ??= {})[key] = {
      version: 1, project, journal: { project, request, phase: "queued", pid: process.pid },
    };
    save();
    return true;
  }

  beginCommit(project: LedgerProject, start: CommitStart): boolean {
    const { state, all, save } = this.loadProject(project);
    const key = jobKey(start.request.jobId);
    const old = currentJob(state, key);
    if (!isDeepStrictEqual(start.project, project) || start.request.projectId !== project.id ||
        (old && (old.journal.phase !== "queued" || !isDeepStrictEqual(old.project, project) ||
          !isDeepStrictEqual(old.journal.request, start.request)))) return false;
    for (const candidate of Object.values(all)) {
      for (const [id] of Object.entries(candidate.commitJobs ?? {})) {
        const job = currentJob(candidate, id)!;
        if (job.project.commonDir === project.commonDir && job.journal.phase !== "queued" && !isTerminal(job.journal)) {
          throw new Error(jobReason(job) ?? "Vizzo must recover an unfinished source-control commit first");
        }
      }
    }
    (state.commitJobs ??= {})[key] = { version: 1, project, journal: start };
    save();
    return true;
  }

  private loadCommit(key: CommitJobKey) {
    this.persistence.content(key.projectId);
    const all = this.persistence.load();
    const state = all[key.projectId];
    const id = jobKey(key.jobId);
    const job = currentJob(state, id);
    if (!state || !job) throw new Error("The source-control commit job disappeared");
    this.persistence.assertExternal(key.projectId, [job.project.root, job.project.gitDir, job.project.commonDir]);
    return { job, state, id, content: this.persistence.content(key.projectId),
      save: () => this.saveProject(all, key.projectId, state) };
  }

  pinCommit(key: CommitJobKey, frozen: FrozenCommitSelection<CommitOwnershipReceipt>): CommitOwnershipPlan {
    const { job, state, id, content, save } = this.loadCommit(key);
    if (job.journal.phase !== "locking" || !("step" in job.journal) || job.journal.step !== "freeze-selection") {
      throw new Error("The commit is no longer freezing its selection");
    }
    assertUnpinned(state);
    const head = readLedgerHead(wholeWorktree(job.project));
    if (!sameHead(head, job.journal.head) || !sameHead(head, state.head)) throw new Error("HEAD moved: review again");
    const pending = new Set(Object.values(state.receipts).filter((receipt) => receipt.pending.length).map(({ executionId }) => executionId));
    const owners = new Set(job.journal.request.writerIds);
    const records = state.writerRecords ?? {};
    if (Object.values(records).some((record) => owners.has(changeWriterId(record.writer)) &&
        (record.phase !== "settled" || pending.has(record.executionId))) ||
        frozen.ownership.paths.some(({ hunks }) => hunks.some(({ executionIds }) => executionIds.some((executionId) => {
          const record = executionId === null ? undefined : records[executionKey(executionId)];
          return executionId !== null && (!record || !owners.has(changeWriterId(record.writer)));
        })))) throw new Error("Changed meanwhile: review again. A selected writer changed.");
    let plan: CommitOwnershipPlan;
    try { plan = pinCommitOwnership(ownershipSnapshot(state, job.project), frozen, content); }
    catch (error) {
      if (error instanceof CommitOwnershipError) throw new Error(`Changed meanwhile: review again. ${error.message}`);
      throw error;
    }
    job.pin = plan;
    state.pinnedJob = id;
    save();
    return plan;
  }

  checkpointCommit(record: CommitProgress, proof?: PublishedBaseEvidence): void {
    const { job, state, id, content, save } = this.loadCommit({ projectId: record.project.id, jobId: record.request.jobId });
    if (job.journal.phase === "queued" || isTerminal(job.journal) || !isDeepStrictEqual(job.journal.request, record.request) ||
        !isDeepStrictEqual(record.project, job.project) || record.pid !== job.journal.pid) {
      throw new Error("The source-control commit journal changed");
    }
    if ("ownership" in record && record.ownership && record.phase !== "refused" && (
      state.pinnedJob !== id || !isDeepStrictEqual(job.pin, record.ownership)
    )) throw new Error("The source-control commit selection is no longer pinned");
    if (proof) {
      if (record.phase !== "publishing" || record.step !== "prepare-ref") throw new Error("Unexpected candidate base proof");
      const normalized = {
        commit: proof.commit, paths: proof.paths.map(({ path, raw, working }) => ({
          path, raw: raw && Buffer.from(raw),
          working: working.kind === "file" || working.kind === "symlink" ? { ...working, bytes: Buffer.from(working.bytes) } : working,
        })),
      };
      validateCommitOwnershipCandidate(ownershipSnapshot(state, job.project), record, normalized, content);
      job.prepared = {
        commit: proof.commit, paths: normalized.paths.map(({ path, raw, working }) => ({
          path, raw: raw && content.put(raw), working: storeEntry(working, content),
        })),
      };
    } else if (record.phase === "publishing" && record.step === "prepare-ref") {
      throw new Error("The commit candidate has no verified Git base");
    }
    if (state.pinnedJob === id && isTerminal(record)) this.releasePin(job, state, content, record.phase === "done" ? record : undefined);
    job.journal = record;
    save();
  }

  private releasePin(
    job: CommitJobRecord, state: ProjectState, content: Content,
    published?: Omit<Extract<CommitProgress, { phase: "done" }>, "receipt">,
  ): void {
    const before = state.head;
    const previous = new Map<string, Chain>();
    if (published) {
      if (!job.prepared) throw new Error("The published commit is missing its verified Git base");
      const proof = {
        commit: job.prepared.commit, paths: job.prepared.paths.map(({ path, raw, working }) => ({
          path, raw: raw === null ? null : content.get(raw), working: (working.kind === "file" || working.kind === "symlink"
            ? { ...working, bytes: bytesFor(working, content) } : working) as ReadEntry,
        })),
      };
      const nextHead = { branch: published.head.branch, oid: published.commit };
      let updates = settleCommitOwnership(ownershipSnapshot(state, job.project), published, proof, content);
      const ownership = explainFrozenGaps(state, published.ownership, nextHead, content);
      if (ownership !== published.ownership) {
        updates = settleCommitOwnership(ownershipSnapshot(state, job.project), { ...published, ownership }, proof, content);
      }
      for (const { path, chain } of updates) {
        previous.set(path, state.files[fileKey(path)]!);
        state.files[fileKey(path)] = chain;
        normalizeTip(state, fileKey(path));
      }
      rebaseState(state, job.project, nextHead, content, new Set(previous.keys()));
    }
    replayHeld(state, job.project, before, state.head, previous, content);
    delete state.pinnedJob;
    delete job.pin;
    delete job.prepared;
  }

  commitJob({ projectId, jobId }: CommitJobKey): CommitJobRecord | null {
    this.persistence.content(projectId);
    return currentJob(this.persistence.load()[projectId], jobKey(jobId)) ?? null;
  }

  commitJobs(projectId?: string): CommitJobSummary[] {
    const all = this.persistence.load();
    if (projectId !== undefined) this.persistence.content(projectId);
    return Object.entries(all).flatMap(([id, state]) => projectId === undefined || id === projectId
      ? Object.keys(state.commitJobs ?? {}).map((key) => summarizeJob(currentJob(state, key)!)) : []);
  }

  checkpointRecovery(key: CommitJobKey, checkpoint: CommitRecoveryCheckpoint): void {
    const { job, save } = this.loadCommit(key);
    if (job.journal.phase === "queued" || isTerminal(job.journal)) throw new Error("The commit job cannot be recovered");
    job.recovery = checkpoint;
    save();
  }

  finishRecovery(key: CommitJobKey, outcome: RecoveryOutcome): void {
    const { job, state, id, content, save } = this.loadCommit(key);
    const record = job.journal;
    if (isTerminal(record)) throw new Error("The commit job was already settled");
    if (outcome.status === "done") {
      if (state.pinnedJob !== id || !("commit" in record) || record.commit !== outcome.commit) {
        throw new Error("The recovered publication no longer matches the pinned commit");
      }
      this.releasePin(job, state, content, { ...record, phase: "done", evidence: "published" });
    } else if ((outcome.status === "refused" || outcome.status === "not-published") && state.pinnedJob === id) {
      this.releasePin(job, state, content);
    }
    if (outcome.status === "done" || outcome.status === "refused" || outcome.status === "not-published") {
      job.journal = { ...record, phase: outcome.status };
      delete job.recovery;
    } else if (outcome.status !== "blocked") {
      job.recovery = null;
    }
    job.outcome = outcome;
    delete job.issue;
    save();
  }

  noteCommitIssue(key: CommitJobKey, reason: string): void {
    const { job, save } = this.loadCommit(key);
    if (!isTerminal(job.journal)) {
      job.issue = reason;
      save();
    }
  }

  saveWriter(project: LedgerProject, execution: WriterExecutionRecord): void {
    this.persistence.assertExternal(project.id, [project.root, project.gitDir, project.commonDir]);
    const all = this.persistence.load();
    const state = all[project.id] ?? newState(readLedgerHead(project));
    const id = executionKey(execution.executionId);
    for (const candidate of [state, ...Object.values(all)]) {
      const pinned = candidate.executions[id];
      if (pinned && (pinned.id !== project.id || pinned.gitDir !== project.gitDir ||
          pinned.scope !== project.scope || pinned.servedDir !== project.servedDir)) throw new Error("Execution project scope changed");
    }
    if (execution.folder !== project.servedDir) throw new Error("Writer execution folder differs from the pinned scope");
    state.executions[id] = project;
    (state.writerRecords ??= {})[id] = execution;
    all[project.id] = state;
    this.persistence.save(all);
  }

  async restoreWriters(): Promise<void> {
    const all = this.persistence.load();
    const attempts = new Map<string, Promise<boolean>>();
    const unresolved = Object.values(all).flatMap((state) =>
      Object.values(state.writerRecords ?? {}).filter((writer) => writer.phase !== "settled"));
    await Promise.all(unresolved.map(async (writer) => {
      const previous = writer.nativeProcess;
      let stopped = writer.phase === "queued" || writer.nativeDispatched === false;
      if (previous) {
        const key = JSON.stringify(previous);
        const stopping = attempts.get(key) ?? stopVerifiedOrphanNativeProcess(previous);
        attempts.set(key, stopping);
        stopped = await stopping.catch(() => false);
      }
      writer.outcome = "interrupted";
      const escaped = writer.nativeDispatched !== false && writer.requiresNativeConfirmation;
      writer.phase = stopped && !escaped ? "settled" : "unconfirmed";
      if (stopped) delete writer.nativeProcess;
      if (escaped) writer.reason = "OpenCode may have left a detached shell running without confirming it stopped";
      else if (!stopped) writer.reason = "Vizzo could not verify that the previous harness and its tools stopped";
      else delete writer.reason;
    }));
    if (unresolved.length) this.persistence.save(all);
  }

  writerSnapshot(projectId: string, now = Date.now()): ProjectWriterSnapshot {
    this.persistence.content(projectId); // Validate the journal key.
    this.pending(now);
    const state = this.persistence.load()[projectId];
    const pending = new Set(Object.values(state?.receipts ?? {}).flatMap((receipt) =>
      receipt.pending.length ? [receipt.executionId] : []));
    return {
      projectId, executions: Object.values(state?.writerRecords ?? {}).map(({ nativeProcess: _privateIdentity, ...record }) => ({
        ...record, projectId, pending: pending.has(record.executionId),
      })),
    };
  }

  pending(now = Date.now()): { executionIds: string[]; deadline?: number } {
    const all = this.persistence.load();
    const changed: string[] = [];
    const ids = new Set<string>();
    let deadline = Infinity;
    for (const [projectId, state] of Object.entries(all)) {
      if (state.pinnedJob === undefined && expire(state, now)) changed.push(projectId);
      for (const receipt of Object.values(state.receipts)) {
        if (!receipt.pending.length) continue;
        ids.add(receipt.executionId);
        if (state.pinnedJob === undefined) deadline = Math.min(deadline, receipt.expiresAt);
      }
    }
    if (changed.length) {
      this.persistence.save(all);
      for (const projectId of changed) {
        this.persistence.content(projectId).prune(blobIds(all[projectId]!));
        this.onExpired?.(projectId);
      }
    }
    return { executionIds: [...ids], deadline: Number.isFinite(deadline) ? deadline : undefined };
  }
}
