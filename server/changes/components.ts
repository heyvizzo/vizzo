import { createHash } from "node:crypto";
import type {
  ChangeComponent, ChangeDiff, ChangeFile, ChangeGroup, ChangeHunk, ChangeRange, ChangesView, ChangeWriter,
} from "../../shared/changes.ts";
import type { CommitRequest, FrozenCommitSelection } from "./commitTransaction.ts";
import type { GitScanEntry, GitScanHead, GitScanResult, GitScanScope } from "./gitScan.ts";
import type { FrozenGitEntry } from "./gitTree.ts";
import type { LlmProvider } from "../../shared/config.ts";

type FileMode = "100644" | "100755";
type Mode = FileMode | "120000";

// The ledger supplies SHA-256 names of exact working-form bytes, including symlink link text.
type LedgerEntry =
  | { readonly kind: "absent" | "opaque" }
  | { readonly kind: "file"; readonly mode: FileMode; readonly blob: string }
  | { readonly kind: "symlink"; readonly blob: string };

interface LedgerSnapshot {
  readonly path: string;
  readonly base: LedgerEntry;
  readonly current: LedgerEntry;
}

interface LedgerHunk {
  readonly kind: ChangeHunk["kind"];
  readonly range?: ChangeRange;
  readonly ownership: { readonly owners: readonly (string | null)[]; readonly ties: readonly string[] };
  readonly reason?: string;
}

interface LedgerFile extends LedgerSnapshot {
  readonly moves: readonly string[];
  readonly hunks: readonly LedgerHunk[];
}

interface WriterRecord {
  readonly executionId: string;
  readonly writer: ChangeWriter;
  readonly title: string;
  readonly request?: string;
  readonly folder?: string | null;
  readonly harness?: LlmProvider;
  readonly purpose?: string;
  readonly continuesExecutionId?: string;
  readonly nativeSessionId?: string;
  readonly phase: "queued" | "running" | "settling" | "unconfirmed" | "settled";
  readonly pending: boolean;
  readonly outcome?: "completed" | "stopped" | "failed" | "timed-out" | "interrupted";
}

export interface ClosedChangeGroup {
  readonly writer: ChangeWriter;
  readonly title: string;
  readonly reason?: string;
}

export interface ChangeComponentInput {
  readonly projectId: string;
  readonly scope: GitScanScope;
  readonly head: GitScanHead;
  readonly generation: number;
  /** Read by scanGitChanges for this exact scope and HEAD. */
  readonly git: GitScanResult;
  readonly ledger: {
    readonly head: GitScanHead;
    readonly headMoved: boolean;
    readonly files: readonly LedgerFile[];
    readonly snapshots: readonly LedgerSnapshot[];
  };
  readonly writers: { readonly projectId: string; readonly executions: readonly WriterRecord[] };
  readonly closedGroups?: readonly ClosedChangeGroup[];
  readonly notices?: readonly string[];
  readonly grokInScope?: boolean;
}

export interface ReviewedChanges {
  readonly projectId: string;
  readonly scope: string;
  readonly head: string;
  readonly generation: number;
  readonly componentIds: readonly string[];
}

interface EntryAnchor {
  readonly mode: Mode;
  readonly sha256: string;
}

interface BaseAnchor extends EntryAnchor {
  readonly oid: string;
  readonly rawSha256: string;
}

interface SelectedHunk {
  readonly componentId: string;
  readonly kind: ChangeHunk["kind"];
  readonly range?: ChangeRange;
  readonly executionIds: readonly (string | null)[];
  readonly ties: readonly string[];
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
}

export interface ChangeOwnershipReceipt {
  readonly version: 1;
  readonly projectId: string;
  readonly scope: Readonly<GitScanScope>;
  readonly head: Readonly<GitScanHead>;
  readonly generation: number;
  readonly componentIds: readonly string[];
  readonly paths: readonly {
    readonly path: string;
    readonly base: BaseAnchor | null;
    readonly working: EntryAnchor | null;
    readonly frozen: EntryAnchor | null;
    readonly moves: readonly string[];
    readonly hunks: readonly SelectedHunk[];
  }[];
}

interface ByteSpan {
  readonly start: number;
  readonly end: number;
}

interface JoinedHunk {
  readonly kind: ChangeHunk["kind"];
  readonly range?: ChangeRange;
  readonly oldBytes?: ByteSpan;
  readonly newBytes?: ByteSpan;
  readonly executionIds: readonly (string | null)[];
  readonly ties: readonly string[];
  readonly reason?: string;
}

interface JoinedEntry {
  readonly key: string;
  readonly path: string | null;
  readonly display: string;
  readonly base: (BaseAnchor & { raw: Buffer; working: Buffer }) | null;
  readonly current: (EntryAnchor & { bytes: Buffer }) | null;
  readonly whole: boolean;
  readonly wholeReason: GitScanEntry["wholeEntryReason"];
  readonly blocked?: string;
  readonly partialFingerprint: string;
  readonly wholeFingerprint: string;
  readonly moves: readonly string[];
  readonly hunks: readonly JoinedHunk[];
}

interface Member {
  readonly entry: JoinedEntry;
  readonly hunk: JoinedHunk;
}

interface WriterStatus {
  readonly writer: ChangeWriter;
  readonly title: string;
  readonly state: ChangeGroup["state"];
  readonly reason?: string;
}

interface IncompleteWork {
  readonly reason: string;
  readonly continuation?: { readonly executionId: string; readonly request: string; readonly nativeSessionId?: string };
}

interface ComponentDetails {
  readonly members: readonly Member[];
  readonly writerIds: readonly string[];
  readonly presentation: ChangeComponent;
}

const details = Symbol("change component data");
export interface ChangeComponentGraph {
  readonly view: ChangesView;
  readonly review: ReviewedChanges;
  readonly [details]: {
    readonly head: Readonly<GitScanHead>;
    readonly scope: Readonly<GitScanScope>;
    readonly components: ReadonlyMap<string, ComponentDetails>;
    readonly working: readonly string[];
    readonly groups: ReadonlyMap<string, ChangeGroup>;
    readonly statuses: ReadonlyMap<string, WriterStatus>;
    readonly incomplete: ReadonlyMap<string, IncompleteWork>;
    readonly incompleteExecutions: ReadonlyMap<string, IncompleteWork>;
    readonly executionWriters: ReadonlyMap<string, string>;
    readonly movedPaths: ReadonlySet<string>;
  };
}

const NO_BYTES = Buffer.alloc(0);
const OTHER = [null] as const;
const FINGERPRINT_MISMATCH = "The ledger and Git read different versions of this entry";
const MISSING_MOVE = "Both endpoints of this move must be available";
const UNKNOWN_WRITER = "A writer's execution could not be verified";
const DETACHED = "HEAD is detached";
const STAGED = "This path has staged changes";
const WORKING = "A writer is still working";
const STOPPING = "A writer is still stopping";
const UNCONFIRMED = "Vizzo couldn't confirm a writer stopped";

export function changeWriterId({ kind, id }: ChangeWriter): string {
  return JSON.stringify([kind, id]);
}

function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fingerprint(value: readonly unknown[]): string {
  return hash(JSON.stringify(value));
}

function matchesBlob(bytes: Buffer, oid: string): boolean {
  if (oid.length !== 40 && oid.length !== 64) return false;
  return createHash(oid.length === 40 ? "sha1" : "sha256").update("blob " + bytes.length + "\0").update(bytes).digest("hex") === oid;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function unique<T extends string | null>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort((a, b) => a === b ? 0 : a === null || (b !== null && a < b) ? -1 : 1);
}

function indexBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (result.has(id)) throw new Error("Duplicate source-control scan evidence");
    result.set(id, value);
  }
  return result;
}

function isMode(mode: string): mode is Mode {
  return mode === "100644" || mode === "100755" || mode === "120000";
}

function ledgerMatches(ledger: LedgerEntry, git: EntryAnchor | null): boolean {
  if (!git) return ledger.kind === "absent";
  if (git.mode === "120000") return ledger.kind === "symlink" && ledger.blob === git.sha256;
  return ledger.kind === "file" && ledger.mode === git.mode && ledger.blob === git.sha256;
}

function sameSnapshot(snapshot: LedgerSnapshot, base: EntryAnchor | null, current: EntryAnchor | null): boolean {
  return ledgerMatches(snapshot.base, base) && ledgerMatches(snapshot.current, current);
}

function lineCount(bytes: Buffer): number {
  let count = Number(bytes.length > 0 && bytes.at(-1) !== 10);
  for (const byte of bytes) if (byte === 10) count++;
  return count;
}

function offsets(bytes: Buffer): Uint32Array {
  const count = lineCount(bytes) + 1;
  const result = new Uint32Array(count);
  let line = 0;
  for (let at = 0; at < bytes.length; at++) {
    if (bytes[at] === 10) result[++line] = at + 1;
  }
  result[count - 1] = bytes.length;
  return result;
}

function slice(bytes: Buffer, span: ByteSpan): Buffer {
  return bytes.subarray(span.start, span.end);
}

function validRange(range: ChangeRange): boolean {
  return [range.oldStart, range.oldCount, range.newStart, range.newCount].every((n) => Number.isSafeInteger(n) && n >= 0)
    && (range.oldCount > 0 || range.newCount > 0);
}

type EntryStructure = "presence" | "type" | "mode";

function structures(base: EntryAnchor | null, current: EntryAnchor | null): EntryStructure[] {
  const required: EntryStructure[] = [];
  if ((base === null) !== (current === null)) required.push("presence");
  if (base && current && (base.mode === "120000") !== (current.mode === "120000")) required.push("type");
  const defaultMode = base && base.mode !== "120000" ? base.mode : "100644";
  if (current && current.mode !== "120000" && current.mode !== defaultMode) required.push("mode");
  return required;
}

function canonicalRange({ oldStart, oldCount, newStart, newCount }: ChangeRange): ChangeRange {
  return { oldStart, oldCount, newStart, newCount };
}

/** Validate that all ranges in order reconstruct the complete current snapshot, including omitted context. */
function joinedHunks(
  file: LedgerFile, before: Buffer, after: Buffer, structural: readonly EntryStructure[],
): JoinedHunk[] | null {
  const oldOffsets = offsets(before);
  const newOffsets = offsets(after);
  const content: JoinedHunk[] = [];
  const metadata: JoinedHunk[] = [];
  const expected = new Set<ChangeHunk["kind"]>(structural);
  let oldEnd = 0;
  let newEnd = 0;
  for (const { kind, range, ownership, reason } of file.hunks) {
    const executionIds = unique(ownership.owners);
    if (!executionIds.length) return null;
    const hunk = { kind, executionIds, ties: unique(ownership.ties), reason };
    if (kind !== "content") {
      if (range || !expected.delete(kind) || ((kind === "type" || kind === "mode") && executionIds.some((id) => id !== null))) return null;
      metadata.push(hunk);
      continue;
    }
    if (!range || !validRange(range)) return null;
    const oldBytes = { start: oldOffsets[range.oldStart], end: oldOffsets[range.oldStart + range.oldCount] };
    const newBytes = { start: newOffsets[range.newStart], end: newOffsets[range.newStart + range.newCount] };
    if (oldBytes.start === undefined || oldBytes.end === undefined || newBytes.start === undefined || newBytes.end === undefined) return null;
    const oldSpan = { start: oldBytes.start, end: oldBytes.end };
    const newSpan = { start: newBytes.start, end: newBytes.end };
    if (oldSpan.start < oldEnd || newSpan.start < newEnd ||
        !before.subarray(oldEnd, oldSpan.start).equals(after.subarray(newEnd, newSpan.start)) ||
        slice(before, oldSpan).equals(slice(after, newSpan))) return null;
    oldEnd = oldSpan.end;
    newEnd = newSpan.end;
    content.push({ ...hunk, range: canonicalRange(range), oldBytes: oldSpan, newBytes: newSpan });
  }
  if (expected.size || !before.subarray(oldEnd).equals(after.subarray(newEnd))) return null;
  return [...content, ...metadata.sort((a, b) => a.kind < b.kind ? -1 : 1)];
}

function otherHunks(before: Buffer, after: Buffer, structural: readonly EntryStructure[], reason?: string): JoinedHunk[] {
  const hunks: JoinedHunk[] = [];
  if (!before.equals(after)) hunks.push({
    kind: "content",
    range: { oldStart: 0, oldCount: lineCount(before), newStart: 0, newCount: lineCount(after) },
    oldBytes: { start: 0, end: before.length },
    newBytes: { start: 0, end: after.length },
    executionIds: OTHER, ties: [], reason,
  });
  for (const kind of structural) hunks.push({ kind, executionIds: OTHER, ties: [], reason });
  return hunks;
}

function attributes(attrs: GitScanEntry["attributes"]["base"]) {
  return attrs && [attrs.filter, attrs.ident, attrs["working-tree-encoding"], attrs.diff].map((value) => value?.toString("hex") ?? null);
}

function joinEntry(entry: GitScanEntry, ledger: LedgerFile | undefined, snapshot: LedgerSnapshot | undefined, sameHead: boolean): JoinedEntry | null {
  const key = entry.pathBytes.toString("hex");
  const display = entry.projectPath ?? JSON.stringify(entry.pathBytes.toString("latin1"));
  const staged = entry.status.some(({ xy }) => !!xy && xy[0] !== ".");
  const before = entry.base;
  const after = entry.current;
  const base = before && isMode(before.mode) && before.raw && before.working && before.workingSha256 ? {
    mode: before.mode, oid: before.oid, raw: Buffer.from(before.raw), working: Buffer.from(before.working),
    sha256: hash(before.working), rawSha256: hash(before.raw),
  } : null;
  const current = after && isMode(after.mode) ? {
    mode: after.mode, bytes: Buffer.from(after.bytes), sha256: hash(after.bytes),
  } : null;
  const badRead = (before && (!base || base.sha256 !== before.workingSha256 || !matchesBlob(base.raw, base.oid)))
    || (after && (!current || current.sha256 !== after.sha256));
  const unavailable = entry.otherReason ?? (badRead ? "Git entry fingerprint could not be verified" : undefined)
    ?? (!entry.path || !entry.projectPath || !Buffer.from(entry.path).equals(entry.pathBytes) ? "Unsupported Git pathname" : undefined);
  const structural = structures(base, current);
  const left = base?.working ?? NO_BYTES;
  const right = current?.bytes ?? NO_BYTES;
  const matches = sameHead && !!ledger && !!snapshot && sameSnapshot(ledger, base, current) && sameSnapshot(snapshot, base, current);
  const opaque = matches ? ledger.hunks.find(({ kind }) => kind === "opaque") : undefined;
  const matchedHunks = matches && !opaque && !unavailable ? joinedHunks(ledger, left, right, structural) : null;
  const reason = unavailable ?? opaque?.reason ?? (opaque ? "The ledger could not read this entry" : undefined);
  const mismatch = ledger && !matchedHunks ? FINGERPRINT_MISMATCH : undefined;
  const hunks = reason ? [{ kind: "opaque", executionIds: OTHER, ties: [], reason } as const]
    : matchedHunks ?? otherHunks(left, right, structural, mismatch);
  if (!hunks.length && !staged) return null;

  const baseAttrs = attributes(entry.attributes.base);
  const currentAttrs = attributes(entry.attributes.current);
  const hasConversion = left.includes(13) || right.includes(13) || (base && !base.raw.equals(base.working)) ||
    !baseAttrs || !currentAttrs || [...baseAttrs.slice(0, 3), ...currentAttrs.slice(0, 3)].some((attr) => attr !== null);
  const wholeReason = entry.wholeEntryReason ?? (hasConversion ? "conversion" : null);
  const whole = entry.conversion === "whole" || wholeReason !== null || !matchedHunks;
  const partialFingerprint = fingerprint([
    key, entry.path, display, base?.oid, base?.mode, base?.rawSha256, current !== null, staged,
  ]);
  return {
    key, path: entry.path, display, base, current, whole, wholeReason, blocked: reason ?? (staged ? STAGED : undefined),
    moves: unique(ledger?.moves ?? []),
    hunks: hunks.length ? hunks : [{ kind: "opaque", executionIds: OTHER, ties: [], reason: STAGED }],
    partialFingerprint,
    wholeFingerprint: fingerprint([
      partialFingerprint, before?.mode, before?.oid, base?.sha256, after?.mode, current?.sha256,
      baseAttrs, currentAttrs, wholeReason, reason,
      entry.status.map(({ raw, originalPathBytes }) => [raw.toString("hex"), originalPathBytes?.toString("hex")]).sort(),
    ]),
  };
}

class Components {
  private readonly parents: number[];
  constructor(size: number) { this.parents = Array.from({ length: size }, (_, index) => index); }

  root(index: number): number {
    while (this.parents[index] !== index) {
      index = this.parents[index] = this.parents[this.parents[index]!]!;
    }
    return index;
  }

  join(a: number, b: number): void {
    this.parents[this.root(b)] = this.root(a);
  }
}

function noteMove(moves: Map<string, Set<string>>, id: string, path: string): void {
  const paths = moves.get(id) ?? new Set<string>();
  paths.add(path);
  moves.set(id, paths);
}

function ancestors(path: string): string[] {
  const result: string[] = [];
  for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
    result.push(path.slice(0, at));
  }
  return result;
}

function connect(
  entries: readonly JoinedEntry[], input: ChangeComponentInput,
): { groups: Member[][]; blockedMoves: ReadonlySet<string>; movedPaths: ReadonlySet<string> } {
  const members: Member[] = [];
  const byPath = new Map<string, number[]>();
  for (const entry of entries) {
    byPath.set(entry.key, entry.hunks.map((hunk) => members.push({ entry, hunk }) - 1));
  }
  const components = new Components(members.length);
  const moves = new Map<string, Set<string>>();
  for (const { path, moves: observed } of input.ledger.files) {
    for (const move of observed) noteMove(moves, move, Buffer.from(path).toString("hex"));
  }
  for (const { status } of input.git.entries) {
    for (const record of status) {
      if (record.kind !== "rename" || !record.originalPathBytes || !record.score?.startsWith("R")) continue;
      const id = JSON.stringify(["git-rename", record.originalPathBytes.toString("hex"), record.pathBytes.toString("hex")]);
      noteMove(moves, id, record.pathBytes.toString("hex"));
      noteMove(moves, id, record.originalPathBytes.toString("hex"));
    }
  }
  const blockedMoves = new Set<string>();
  const movedPaths = new Set<string>();
  for (const paths of moves.values()) {
    const endpoints = [...paths].map((path) => byPath.get(path));
    const complete = paths.size === 2 && endpoints.every((part) => part?.length);
    const joined = endpoints.flatMap((part) => part ?? []);
    for (const path of paths) {
      movedPaths.add(path);
      if (!complete) blockedMoves.add(path);
    }
    for (const index of joined) components.join(joined[0]!, index);
  }

  const ties = new Map<string, number>();
  for (const entry of entries) {
    const indexes = byPath.get(entry.key)!;
    const structural = indexes.find((index) => {
      const kind = members[index]!.hunk.kind;
      return kind === "presence" || kind === "type";
    });
    let previousContent: number | undefined;
    for (const index of indexes) {
      const { hunk } = members[index]!;
      if (entry.whole) components.join(indexes[0]!, index);
      if (structural !== undefined && hunk.kind === "content") components.join(structural, index);
      if (hunk.oldBytes && previousContent !== undefined && members[previousContent]!.hunk.oldBytes?.end === hunk.oldBytes.start) {
        components.join(previousContent, index);
      }
      if (hunk.oldBytes) previousContent = index;
      for (const tie of hunk.ties) {
        const previous = ties.get(tie);
        if (previous === undefined) ties.set(tie, index);
        else components.join(previous, index);
      }
    }
  }

  // Replacing a file with a directory (or the reverse) requires selecting every displaced entry.
  const byRepoPath = new Map(entries.flatMap((entry) => entry.path ? [[entry.path, entry] as const] : []));
  const structuralMember = (entry: JoinedEntry): number | undefined => byPath.get(entry.key)?.find((index) =>
    members[index]!.hunk.kind === "presence" || members[index]!.hunk.kind === "opaque");
  for (const child of entries) {
    if (!child.path) continue;
    for (const ancestor of ancestors(child.path)) {
      const parent = byRepoPath.get(ancestor);
      if (!parent || (!(parent.base && child.current) && !(child.base && parent.current))) continue;
      const from = structuralMember(parent);
      const to = structuralMember(child);
      if (from !== undefined && to !== undefined) components.join(from, to);
    }
  }

  const groups = new Map<number, Member[]>();
  for (const [index, member] of members.entries()) {
    const root = components.root(index);
    const at = groups.get(root) ?? [];
    at.push(member);
    groups.set(root, at);
  }
  return { groups: [...groups.values()], blockedMoves, movedPaths };
}

const writerBlocks = [
  undefined,
  { state: "working", reason: WORKING },
  { state: "stopping", reason: STOPPING },
  { state: "stopping", reason: UNCONFIRMED },
] as const;

function writerBlock({ phase, outcome, pending }: WriterRecord): number {
  if (phase === "unconfirmed") return 3;
  if (phase === "settling" && outcome === "stopped") return 2;
  return Number(phase !== "settled" || pending);
}

function writerStatuses(records: Iterable<WriterRecord>, closed: ReadonlyMap<string, ClosedChangeGroup>): Map<string, WriterStatus> {
  const writers = new Map<string, WriterRecord>();
  const blocked = new Map<string, number>();
  for (const record of records) {
    const id = changeWriterId(record.writer);
    writers.set(id, record);
    blocked.set(id, Math.max(blocked.get(id) ?? 0, writerBlock(record)));
  }
  return new Map([...writers].map(([id, record]) => [id, {
    writer: { ...record.writer }, title: closed.get(id)?.title ?? record.title,
    ...writerBlocks[blocked.get(id)!] ?? { state: closed.has(id) ? "closed" : "open" },
  }]));
}

function continuedExecutions(records: ReadonlyMap<string, WriterRecord>): Set<string> {
  const continued = new Set<string>();
  for (const execution of records.values()) {
    if (!execution.continuesExecutionId || execution.phase !== "settled" || execution.pending ||
        execution.outcome !== "completed" || execution.purpose === "reconcile") continue;
    const previous = records.get(execution.continuesExecutionId);
    if (previous && previous.phase === "settled" && !previous.pending && previous.outcome &&
        previous.outcome !== "completed" && previous.folder === execution.folder && previous.nativeSessionId &&
        previous.nativeSessionId === execution.nativeSessionId &&
        changeWriterId(previous.writer) === changeWriterId(execution.writer)) continued.add(previous.executionId);
  }
  return continued;
}

const incompleteReasons = {
  stopped: "A task was stopped part-way",
  failed: "A task failed before it finished",
  "timed-out": "A task timed out before it finished",
  interrupted: "A task was interrupted before it finished",
};

/** Work remains incomplete only while the graph contains surviving ownership from that execution. */
export function writerWork(graph: ChangeComponentGraph, writer: ChangeWriter, interruptedExecutionId?: string) {
  const id = changeWriterId(writer);
  const { statuses, groups, incomplete, incompleteExecutions, executionWriters } = graph[details];
  const work = incomplete.get(id);
  const candidate = interruptedExecutionId && executionWriters.get(interruptedExecutionId) === id
    ? incompleteExecutions.get(interruptedExecutionId) : undefined;
  return {
    status: statuses.get(id), group: groups.get(id),
    incomplete: work && interruptedExecutionId ? { reason: candidate?.reason ?? work.reason, continuation: candidate?.continuation } : work,
  };
}

function groupByEntry(members: readonly Member[]): Map<JoinedEntry, JoinedHunk[]> {
  const files = new Map<JoinedEntry, JoinedHunk[]>();
  for (const { entry, hunk } of members) {
    const hunks = files.get(entry) ?? [];
    hunks.push(hunk);
    files.set(entry, hunks);
  }
  return files;
}

function memberFingerprint({ entry, hunk }: Member, moved: boolean): readonly unknown[] {
  const { kind, range, executionIds, ties, reason, oldBytes, newBytes } = hunk;
  if (entry.whole || moved) {
    return [entry.wholeFingerprint, kind, range, executionIds, ties, reason, entry.moves];
  }
  // The base coordinates locate the exact selected bytes even when a different hunk
  // has added or removed lines above them in the current file.
  return [
    entry.partialFingerprint, kind, executionIds, ties, reason,
    range && [range.oldStart, range.oldCount, range.newCount],
    oldBytes && hash(slice(entry.base?.raw ?? NO_BYTES, oldBytes)),
    newBytes && hash(slice(entry.current?.bytes ?? NO_BYTES, newBytes)),
    kind === "mode" ? entry.current?.mode : undefined,
  ];
}

function fileSummary(entry: JoinedEntry, hunks: readonly JoinedHunk[], moved: boolean): ChangeFile {
  const kind = moved ? "move"
    : hunks.some(({ kind }) => kind === "opaque") ? "unavailable"
    : entry.wholeReason === "binary" || entry.wholeReason === "symlink" ? entry.wholeReason
    : hunks.some(({ kind }) => kind === "presence" || kind === "type") ? "presence"
    : hunks.some(({ kind }) => kind === "content") ? "text" : "mode";
  const showLines = kind !== "binary" && kind !== "symlink" && kind !== "unavailable";
  return {
    path: entry.display, entry: kind,
    added: showLines ? hunks.reduce((sum, { range }) => sum + (range?.newCount ?? 0), 0) : 0,
    removed: showLines ? hunks.reduce((sum, { range }) => sum + (range?.oldCount ?? 0), 0) : 0,
  };
}

export function buildChangeComponents(input: ChangeComponentInput): ChangeComponentGraph {
  const { projectId, generation } = input;
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("Invalid source-control scan generation");
  if (input.writers.projectId !== projectId) throw new Error("Writer snapshot belongs to a different project");
  const scope = { worktreeRoot: input.scope.worktreeRoot, projectDir: input.scope.projectDir };
  const head = { branch: input.head.branch, oid: input.head.oid };
  const scopeKey = fingerprint([projectId, scope.worktreeRoot, scope.projectDir]);
  const headKey = fingerprint([head.branch, head.oid]);
  const sameHead = head.branch === input.ledger.head.branch && head.oid === input.ledger.head.oid;
  const ledger = indexBy(input.ledger.files, ({ path }) => path);
  const snapshots = indexBy(input.ledger.snapshots, ({ path }) => path);
  const seen = indexBy(input.git.entries, ({ pathBytes }) => pathBytes.toString("hex"));
  const entries = [...seen.keys()].sort().flatMap((key) => {
    const entry = seen.get(key)!;
    const file = entry.path && ledger.get(entry.path);
    const snapshot = entry.path && snapshots.get(entry.path);
    return joinEntry(entry, file || undefined, snapshot || undefined, sameHead) ?? [];
  });
  const connections = connect(entries, input);
  const records = indexBy(input.writers.executions, ({ executionId }) => executionId);
  const continued = continuedExecutions(records);
  const closed = indexBy(input.closedGroups ?? [], ({ writer }) => changeWriterId(writer));
  const status = writerStatuses(records.values(), closed);
  const components = new Map<string, ComponentDetails>();
  const working = [...status].filter(([, writer]) => writer.reason).map(([id]) => id).sort();
  const executionWriters = new Map([...records].map(([id, record]) => [id, changeWriterId(record.writer)]));
  const presence = new Map<JoinedEntry, string>();
  const dependent = new Map<string, JoinedEntry>();
  const groups = new Map<string, ChangeGroup & { own: string[]; tied: string[] }>();
  const incompleteRecords = new Set<string>();

  for (const members of connections.groups) {
    const paths = groupByEntry(members);
    const executionIds = unique(members.flatMap(({ hunk }) => hunk.executionIds));
    const found = executionIds.flatMap((id) => {
      const record = id === null ? undefined : records.get(id);
      return record ? [record] : [];
    });
    const unknown = found.length < executionIds.filter((id) => id !== null).length;
    const writerIds = unique(found.map(({ executionId }) => executionWriters.get(executionId)!));
    const writers = writerIds.map((id) => status.get(id)!.writer);
    const other = executionIds.includes(null) || unknown;
    const incompleteWriters = new Set(found.flatMap(({ outcome, executionId }) => {
      if (!outcome || outcome === "completed" || continued.has(executionId)) return [];
      incompleteRecords.add(executionId);
      return [executionWriters.get(executionId)!];
    }));
    const incomplete = incompleteWriters.size > 0;
    const reason = (head.branch === null ? DETACHED : undefined)
      ?? [...paths.keys()].find((entry) => entry.blocked)?.blocked
      ?? ([...paths.keys()].some(({ key }) => connections.blockedMoves.has(key)) ? MISSING_MOVE : undefined)
      ?? (unknown ? UNKNOWN_WRITER : undefined)
      ?? writerIds.map((id) => status.get(id)!.reason).find(Boolean);
    const moved = [...paths.keys()].some(({ key }) => connections.movedPaths.has(key));
    const id = fingerprint([
      scopeKey, headKey, moved, other, incomplete, reason, writerIds,
      members.map((member) => memberFingerprint(member, connections.movedPaths.has(member.entry.key))),
    ]);
    const tieReason = other && writers.length ? "Also has Other changes"
      : writers.length > 1 ? "Shared by more than one writer"
      : moved ? "Both paths are part of the same move" : undefined;
    const presentation: ChangeComponent = {
      id, writers, other, files: [...paths].map(([entry, hunks]) => fileSummary(entry, hunks, connections.movedPaths.has(entry.key))),
      selectable: reason === undefined, reason, tieReason, incomplete: incomplete || undefined,
    };
    components.set(id, { members, writerIds, presentation });
    for (const writerId of writerIds) {
      const writer = status.get(writerId)!;
      const closedReason = writer.state === "closed" ? closed.get(writerId)?.reason : undefined;
      const group = groups.get(writerId) ?? { ...writer, ...(closedReason && { reason: closedReason }), own: [], tied: [] };
      (writerIds.length === 1 && !other ? group.own : group.tied).push(id);
      groups.set(writerId, incompleteWriters.has(writerId) ? { ...group, incomplete: true } : group);
    }
    for (const [entry, hunks] of paths) {
      if (entry.base || !entry.current) continue;
      if (hunks.some(({ kind }) => kind === "presence")) presence.set(entry, id);
      else if (hunks.some(({ kind }) => kind === "mode")) dependent.set(id, entry);
    }
  }
  const incomplete = new Map<string, IncompleteWork>();
  const incompleteExecutions = new Map<string, IncompleteWork>();
  for (const record of records.values()) {
    const { executionId, outcome, phase, pending, request, purpose, nativeSessionId } = record;
    if (!incompleteRecords.has(executionId) || !outcome || outcome === "completed") continue;
    const id = executionWriters.get(executionId)!;
    const continuation = phase === "settled" && !pending && request && nativeSessionId && purpose !== "reconcile"
      ? { executionId, request, nativeSessionId } : undefined;
    const reason = incompleteReasons[outcome];
    incompleteExecutions.set(executionId, { reason, continuation });
    incomplete.set(id, { reason, continuation: continuation ?? incomplete.get(id)?.continuation });
  }
  for (const [id, entry] of dependent) {
    const component = components.get(id)!;
    const requiredId = presence.get(entry);
    const required = requiredId ? components.get(requiredId)?.presentation : undefined;
    components.set(id, { ...component, presentation: {
      ...component.presentation,
      requires: required ? [required.id] : undefined,
      selectable: component.presentation.selectable && !!required?.selectable,
      reason: component.presentation.reason ?? (required ? required.reason : "The file's creation must also be selected"),
    } });
  }

  const notices = [...input.notices ?? []];
  if (!sameHead || input.ledger.headMoved) notices.push("HEAD moved: some changes are now marked Other");
  if (input.grokInScope && [...components.values()].some(({ presentation }) => presentation.other)) {
    notices.push("Grok doesn't report file edits. Grok changes appear under Other.");
  }
  const view = deepFreeze<ChangesView>({
    generation, branch: head.branch, base: head.oid, groups: [...groups.values()],
    components: [...components.values()].map(({ presentation }) => presentation), notices: [...new Set(notices)], changedFiles: entries.length,
  });
  const review = deepFreeze<ReviewedChanges>({
    projectId, scope: scopeKey, head: headKey, generation, componentIds: [...components.keys()],
  });
  return Object.freeze({ view, review, [details]: {
    scope: Object.freeze(scope), head: Object.freeze(head), components, working, groups, statuses: status,
    incomplete, incompleteExecutions, executionWriters, movedPaths: connections.movedPaths,
  } });
}

export function getComponentDiff(graph: ChangeComponentGraph, componentId: string, path: string,
  limit?: { hunks: number; bytes: number }): ChangeDiff | null {
  const component = graph[details].components.get(componentId);
  const members = component?.members.filter(({ entry }) => entry.display === path);
  if (!component || !members?.length) return null;
  const writerById = new Map(component.presentation.writers.map((writer) => [changeWriterId(writer), writer]));
  return deepFreeze<ChangeDiff>({
    generation: graph.view.generation, component: componentId, path,
    hunks: (limit ? members.slice(0, limit.hunks) : members).map(({ entry, hunk }) => {
      const writers = unique(hunk.executionIds.flatMap((id) => {
        const writer = id === null ? undefined : graph[details].executionWriters.get(id);
        return writer ? [writer] : [];
      })).map((id) => writerById.get(id)!);
      let before: string | undefined;
      let after: string | undefined;
      if (hunk.oldBytes && hunk.newBytes && entry.wholeReason !== "binary") {
        const beforeBytes = slice(entry.base?.working ?? NO_BYTES, hunk.oldBytes);
        const afterBytes = slice(entry.current?.bytes ?? NO_BYTES, hunk.newBytes);
        if (!beforeBytes.includes(0) && !afterBytes.includes(0)) {
          const text = (bytes: Buffer) => limit && bytes.length > limit.bytes
            ? `${bytes.subarray(0, limit.bytes).toString("utf8")}…` : bytes.toString("utf8");
          before = text(beforeBytes);
          after = text(afterBytes);
        }
      } else if (hunk.kind === "mode" || hunk.kind === "type" || hunk.kind === "presence") {
        before = entry.base?.mode;
        after = entry.current?.mode;
      }
      return {
        kind: hunk.kind, range: hunk.range, before, after, writers,
        other: hunk.executionIds.some((id) => id === null || !graph[details].executionWriters.has(id)), reason: hunk.reason,
      };
    }),
  });
}

function frozenEntry(entry: JoinedEntry, hunks: readonly JoinedHunk[], whole: boolean): FrozenGitEntry | null {
  if (!entry.path) return null;
  if (whole) {
    return entry.current
      ? { path: entry.path, kind: "whole", mode: entry.current.mode, content: Buffer.from(entry.current.bytes) }
      : { path: entry.path, kind: "whole", mode: "0", content: null };
  }
  const presence = hunks.some(({ kind }) => kind === "presence");
  if (presence && !entry.current) return { path: entry.path, kind: "whole", mode: "0", content: null };
  if (!entry.current || (!entry.base && !presence)) return null;
  const mode = hunks.some(({ kind }) => kind === "mode") ? entry.current.mode : entry.base?.mode ?? "100644";
  const base = entry.base?.raw ?? NO_BYTES;
  if (!base.length && (presence || hunks.some(({ kind }) => kind === "content"))) {
    // An empty base cannot establish how Git will convert nonempty content.
    const selected = new Set(hunks);
    if (entry.hunks.every((hunk) => hunk.kind === "mode" || selected.has(hunk))) {
      return { path: entry.path, mode, kind: "whole", content: Buffer.from(entry.current.bytes) };
    }
  }
  const parts: Buffer[] = [];
  let cursor = 0;
  for (const { oldBytes, newBytes } of hunks) {
    if (!oldBytes || !newBytes) continue;
    parts.push(base.subarray(cursor, oldBytes.start), slice(entry.current.bytes, newBytes));
    cursor = oldBytes.end;
  }
  parts.push(base.subarray(cursor));
  return { path: entry.path, mode, kind: "partial", content: Buffer.concat(parts) };
}

function sameSet(expected: ReadonlySet<string>, values: readonly string[]): boolean {
  return expected.size === values.length && new Set(values).size === values.length && values.every((id) => expected.has(id));
}

/**
 * Resolve a request against the trusted review token issued for the original generation and a fresh graph.
 * IDs cover the entries, hunks, ownership and eligibility of the chosen components; unrelated paths can change.
 */
export function freezeChangeSelection(
  reviewed: ReviewedChanges, fresh: ChangeComponentGraph,
  request: Pick<CommitRequest, "projectId" | "generation" | "componentIds" | "writerIds" | "selection">,
): FrozenCommitSelection<ChangeOwnershipReceipt> | null {
  if (request.projectId !== reviewed.projectId || reviewed.projectId !== fresh.review.projectId ||
      request.generation !== reviewed.generation || reviewed.scope !== fresh.review.scope || reviewed.head !== fresh.review.head) return null;
  const wanted = new Set(request.componentIds);
  if (!wanted.size || wanted.size !== request.componentIds.length) return null;
  const seen = new Set(reviewed.componentIds);
  const { selection } = request;
  const ticked = new Set(selection.kind === "explicit" ? selection.otherComponentIds : []);
  if ((selection.kind === "explicit" && ticked.size !== selection.otherComponentIds.length) ||
      [...ticked].some((id) => !wanted.has(id))) return null;
  const graph = fresh[details];
  const selected = [...wanted].sort().flatMap((id) => {
    const component = graph.components.get(id);
    return component && seen.has(id) ? [component] : [];
  });
  const actualWriters = new Set(selected.flatMap(({ writerIds }) => writerIds));
  if (selected.length !== wanted.size || !sameSet(actualWriters, request.writerIds)) return null;
  if (selection.kind === "delete") {
    const group = graph.groups.get(selection.writerId);
    if (!group || group.incomplete || graph.working.includes(selection.writerId) || !sameSet(wanted, group.own)) return null;
  }

  const byEntry = new Map<JoinedEntry, Map<JoinedHunk, string>>();
  for (const { presentation, members, writerIds } of selected) {
    const { id, other, selectable, requires } = presentation;
    if (!selectable || other !== ticked.has(id) || requires?.some((required) => !wanted.has(required)) ||
        (selection.kind !== "explicit" && (writerIds.length !== 1 || writerIds[0] !== selection.writerId))) return null;
    for (const { entry, hunk } of members) {
      const hunks = byEntry.get(entry) ?? new Map();
      hunks.set(hunk, id);
      byEntry.set(entry, hunks);
    }
  }
  const entries: FrozenGitEntry[] = [];
  const paths: ChangeOwnershipReceipt["paths"][number][] = [];
  for (const entry of [...byEntry.keys()].sort((a, b) => a.key < b.key ? -1 : 1)) {
    const selectedHunks = byEntry.get(entry)!;
    const hunks = entry.hunks.filter((hunk) => selectedHunks.has(hunk));
    const whole = entry.whole || graph.movedPaths.has(entry.key);
    const frozen = frozenEntry(entry, hunks, whole);
    if (!frozen || (whole && hunks.length !== entry.hunks.length)) return null;
    entries.push(frozen);
    const { base, current } = entry;
    paths.push({
      path: frozen.path,
      base: base && { mode: base.mode, oid: base.oid, sha256: base.sha256, rawSha256: base.rawSha256 },
      working: current && { mode: current.mode, sha256: current.sha256 },
      frozen: frozen.content && { mode: frozen.mode, sha256: hash(frozen.content) },
      moves: [...entry.moves],
      hunks: hunks.map((hunk) => {
        const { kind, range, executionIds, ties, oldBytes, newBytes } = hunk;
        return {
          componentId: selectedHunks.get(hunk)!, kind, executionIds: [...executionIds], ties: [...ties],
          ...(range && { range }),
          ...(oldBytes && { beforeSha256: hash(slice(base?.working ?? NO_BYTES, oldBytes)) }),
          ...(newBytes && { afterSha256: hash(slice(current?.bytes ?? NO_BYTES, newBytes)) }),
        };
      }),
    });
  }

  return {
    generation: reviewed.generation,
    components: selected.map(({ members, writerIds, presentation }) => ({
      id: presentation.id, incomplete: !!presentation.incomplete, other: presentation.other, writerIds: [...writerIds],
      paths: unique(members.map(({ entry }) => entry.path!)),
    })),
    workingWriterIds: [...graph.working],
    entries,
    ownership: deepFreeze<ChangeOwnershipReceipt>({
      version: 1, generation: reviewed.generation, projectId: reviewed.projectId,
      scope: { ...graph.scope }, head: { ...graph.head }, componentIds: [...wanted].sort(), paths,
    }),
  };
}

type CommittedPath = ChangeOwnershipReceipt["paths"][number];

/** A Vizzo commit leaves the working coordinates alone and shifts the base by its selected hunks. */
function afterPublishedHunks(range: ChangeRange, committed: CommittedPath): ChangeRange | null {
  let delta = 0;
  for (const { range: earlier } of committed.hunks) {
    if (!earlier) continue;
    if (earlier.oldStart + earlier.oldCount <= range.oldStart && earlier.oldStart < range.oldStart) {
      delta += earlier.newCount - earlier.oldCount;
    } else if (range.oldStart + range.oldCount > earlier.oldStart || range.oldStart === earlier.oldStart) {
      return null;
    }
  }
  return { ...range, oldStart: range.oldStart + delta };
}

function sameAnchor(left: EntryAnchor | null, right: EntryAnchor | null): boolean {
  return left?.mode === right?.mode && left?.sha256 === right?.sha256;
}

function afterPublicationKey(component: ComponentDetails, graph: ChangeComponentGraph,
  written: ReadonlyMap<string, CommittedPath>, before: boolean): string | undefined {
  const { other, selectable, reason, incomplete } = component.presentation;
  const members = [];
  for (const member of component.members) {
    const { entry, hunk } = member;
    const moved = graph[details].movedPaths.has(entry.key);
    const committed = entry.path && written.get(entry.path);
    if (!committed) {
      members.push(memberFingerprint(member, moved));
      continue;
    }
    if (entry.whole || moved || !committed.frozen ||
        (hunk.kind !== "content" && hunk.kind !== "mode")) return undefined;
    if (!before && (!sameAnchor(entry.base, committed.frozen) || entry.base?.rawSha256 !== committed.frozen.sha256)) return undefined;
    const range = hunk.range && (before ? afterPublishedHunks(hunk.range, committed) : hunk.range);
    if (range === null) return undefined;
    members.push([
      entry.key, hunk.kind, range && [range.oldStart, range.oldCount, range.newCount], hunk.executionIds, hunk.ties, hunk.reason,
      hunk.oldBytes && hash(slice(entry.base?.working ?? NO_BYTES, hunk.oldBytes)),
      hunk.newBytes && hash(slice(entry.current?.bytes ?? NO_BYTES, hunk.newBytes)),
      hunk.kind === "mode" ? entry.current?.mode : undefined,
    ]);
  }
  return fingerprint([other, selectable, reason, incomplete, component.writerIds, members]);
}

/** Match the same reviewed components after a prior job, without selecting new or enlarged components. */
export function carryChangesAfterPublication(previous: ChangeComponentGraph, next: ChangeComponentGraph,
  selection: ChangeOwnershipReceipt, ids: readonly string[], options?: { allowAnotherScope: boolean }): Map<string, string> {
  const scope = previous[details].scope;
  if (previous.review.projectId !== selection.projectId || selection.projectId !== next.review.projectId ||
      scope.worktreeRoot !== selection.scope.worktreeRoot ||
      (!options?.allowAnotherScope && (scope.projectDir !== selection.scope.projectDir || previous.review.generation !== selection.generation)) ||
      previous.review.head !== fingerprint([selection.head.branch, selection.head.oid]) || previous.review.scope !== next.review.scope ||
      previous[details].head.branch !== next[details].head.branch) return new Map();
  const written = new Map(selection.paths.map((path) => [path.path, path]));
  const byKey = new Map<string, string | null>();
  for (const [id, component] of next[details].components) {
    const key = afterPublicationKey(component, next, written, false);
    if (key !== undefined) byKey.set(key, byKey.has(key) ? null : id);
  }
  const result = new Map<string, string>();
  for (const id of ids) {
    const component = previous[details].components.get(id);
    const key = component && afterPublicationKey(component, previous, written, true);
    const mapped = key && byKey.get(key);
    if (mapped) result.set(id, mapped);
  }
  return result;
}
