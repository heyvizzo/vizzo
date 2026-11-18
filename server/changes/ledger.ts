import { combine } from "./annotations.ts";
import { boundVersions, changeBase, compact, insert, inspect, newChain, observe, place, tip, type Chain, type FileEvidence } from "./chain.ts";
import { sameEntry, storeEntry, type Content, type Entry } from "./entries.ts";
import { batchKey, exactBytes, exactText, MAX_FILE_BYTES, parsePatch, PENDING_MS, TOO_LARGE,
  type EditBatch, type EditChange } from "./evidence.ts";
import { LedgerPersistence } from "./persistence.ts";
import { evidencePath, pathAcceptsEvidence, readBaseEntry, readLedgerHead, readWorkingEntry, sameHead,
  type LedgerHead, type LedgerProject } from "./project.ts";

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
}

interface ProjectState {
  head: LedgerHead;
  headMoved: boolean;
  files: Record<string, Chain>;
  receipts: Record<string, Receipt>;
  executions: Record<string, LedgerProject>;
  moves: Record<string, readonly [string, string]>;
  notices: Record<string, string>;
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

/** Owned exclusively by the ledger worker. Each synchronous operation replaces the journal at most once. */
export class LedgerStore {
  private readonly persistence: LedgerPersistence<ProjectState>;

  constructor(persistence = new LedgerPersistence<ProjectState>()) {
    this.persistence = persistence;
  }

  private open(project: LedgerProject, now: number) {
    this.persistence.assertExternal(project.id, [project.root, project.gitDir, project.commonDir]);
    const all = this.persistence.load();
    const head = readLedgerHead(project);
    const state = all[project.id] ?? newState(head);
    const content = this.persistence.content(project.id);
    expire(state, now);
    if (!sameHead(state.head, head)) {
      const wholeWorktree = { ...project, servedDir: project.root, scope: project.root };
      const rebased = new Set<string>();
      for (const [key, chain] of Object.entries(state.files)) {
        const path = key.slice(1);
        const base = storeEntry(readBaseEntry(wholeWorktree, path, head), content);
        if (!sameEntry(base, chain.base)) {
          rebased.add(path);
          changeBase(chain, base, content);
        }
      }
      expire(state, now, rebased);
      for (const path of rebased) normalizeTip(state, fileKey(path));
      state.head = head;
      state.headMoved = true;
    }
    const save = () => {
      if (!sameHead(state.head, readLedgerHead(project))) throw new Error("Git HEAD moved while updating the source-control ledger");
      cleanMoves(state);
      all[project.id] = state;
      this.persistence.save(all);
      content.prune(blobIds(state));
    };
    return { state, content, all, save };
  }

  ingest(project: LedgerProject, batch: EditBatch, now = Date.now()): BatchResult {
    const key = batchKey(batch);
    const { state, content, all, save } = this.open(project, now);
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
      for (const path of uniquePaths(units)) {
        state.files[fileKey(path)] ??= newChain(storeEntry(readBaseEntry(project, path, state.head), content), content);
      }
      for (const [index, effects] of units.entries()) {
        receipt.results.push("pending");
        receipt.pending.push({ index, effects });
      }
      applyPending(state, content);
      boundAll(state, content);
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
    const pending = new Set(Object.values(state.receipts).flatMap((receipt) =>
      uniquePaths(receipt.pending.map(({ effects }) => effects))));
    for (const path of paths) {
      const chain = state.files[fileKey(path)];
      if (chain && !pending.has(path)) compact(chain, content);
    }
    save();
  }

  pending(now = Date.now()): { executionIds: string[]; deadline?: number } {
    const all = this.persistence.load();
    let changed = false;
    const ids = new Set<string>();
    let deadline = Infinity;
    for (const state of Object.values(all)) {
      changed = expire(state, now) || changed;
      for (const receipt of Object.values(state.receipts)) {
        if (!receipt.pending.length) continue;
        ids.add(receipt.executionId);
        deadline = Math.min(deadline, receipt.expiresAt);
      }
    }
    if (changed) {
      this.persistence.save(all);
      for (const [projectId, state] of Object.entries(all)) this.persistence.content(projectId).prune(blobIds(state));
    }
    return { executionIds: [...ids], deadline: Number.isFinite(deadline) ? deadline : undefined };
  }
}
