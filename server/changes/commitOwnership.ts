import { createHash } from "node:crypto";
import { applyLink, hunkOwnership, initialAnnotation, type Annotation, type OwnedHunk } from "./annotations.ts";
import { annotate, tip, type Chain } from "./chain.ts";
import type { CommitSettlement, FrozenCommitSelection } from "./commitTransaction.ts";
import { ABSENT, bytesFor, type Content, type Entry, type ReadEntry } from "./entries.ts";
import type { GitScanHead, GitScanScope } from "./gitScan.ts";
import type { GitTreeEntry } from "./gitTree.ts";
import { lineCount, type HunkRange } from "./lineDiff.ts";
import { hash } from "./persistence.ts";

interface EntryAnchor {
  readonly mode: GitTreeEntry["mode"];
  readonly sha256: string;
}

interface SelectedHunk {
  readonly componentId: string;
  readonly kind: OwnedHunk["kind"];
  readonly range?: HunkRange;
  readonly executionIds: readonly (string | null)[];
  readonly ties: readonly string[];
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
}

interface SelectedPath {
  readonly path: string;
  readonly base: (EntryAnchor & { readonly oid: string; readonly rawSha256: string }) | null;
  readonly working: EntryAnchor | null;
  readonly frozen: EntryAnchor | null;
  readonly moves: readonly string[];
  readonly hunks: readonly SelectedHunk[];
}

/** Structural input from the component graph's immutable selection receipt. */
export interface CommitOwnershipReceipt {
  readonly version: 1;
  readonly projectId: string;
  readonly scope: Readonly<GitScanScope>;
  readonly head: Readonly<GitScanHead>;
  readonly generation: number;
  readonly componentIds: readonly string[];
  readonly paths: readonly SelectedPath[];
}

export interface CommitOwnershipSnapshot {
  readonly projectId: string;
  readonly scope: Readonly<GitScanScope>;
  readonly head: Readonly<GitScanHead>;
  readonly chains: ReadonlyMap<string, Chain>;
  /** Every path in an unresolved receipt, including both ends of a pending move. */
  readonly pendingPaths: ReadonlySet<string>;
}

interface PinnedPath {
  readonly path: string;
  readonly kind: "partial" | "whole";
  readonly chainSha256: string;
}

export interface CommitOwnershipPlan {
  readonly version: 1;
  readonly receipt: CommitOwnershipReceipt;
  readonly paths: readonly PinnedPath[];
  readonly sha256: string;
}

export interface PublishedBaseEvidence {
  /** The exact published commit whose tree and attributes were used to read these entries. */
  readonly commit: string;
  readonly paths: readonly {
    readonly path: string;
    readonly raw: Buffer | null;
    readonly working: ReadEntry;
  }[];
}

export interface CommitOwnershipUpdate {
  readonly path: string;
  readonly chain: Chain;
  /** Store these bytes before writing the chain and settling the journal in one durable mutation. */
  readonly baseBytes: Buffer | null;
}

export class CommitOwnershipError extends Error {
  constructor(reason: string) {
    super(`Cannot settle source-control ownership: ${reason}`);
    this.name = "CommitOwnershipError";
  }
}

function requireProof(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new CommitOwnershipError(reason);
}

function digest(value: unknown): string {
  return hash(Buffer.from(JSON.stringify(value)));
}

function uniqueIndex<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  const indexed = new Map(items.map((item) => [key(item), item]));
  requireProof(indexed.size === items.length, "duplicate selection or proof");
  return indexed;
}

function sameMembers<T>(left: readonly T[], right: readonly T[]): boolean {
  const members = new Set(left);
  return members.size === left.length && members.size === right.length && new Set(right).size === right.length &&
    right.every((item) => members.has(item));
}

function sameHead(left: Readonly<GitScanHead>, right: Readonly<GitScanHead>): boolean {
  return left.branch === right.branch && left.oid === right.oid;
}

function checkSnapshot(snapshot: CommitOwnershipSnapshot, receipt: CommitOwnershipReceipt): void {
  requireProof(receipt.version === 1 && snapshot.projectId === receipt.projectId &&
    snapshot.scope.worktreeRoot === receipt.scope.worktreeRoot && snapshot.scope.projectDir === receipt.scope.projectDir &&
    sameHead(snapshot.head, receipt.head) && receipt.head.branch !== null, "the project or frozen HEAD changed");
}

function selectedChain(snapshot: CommitOwnershipSnapshot, path: string): Chain {
  requireProof(!snapshot.pendingPaths.has(path), `an unresolved edit still affects ${JSON.stringify(path)}`);
  const chain = snapshot.chains.get(path);
  requireProof(chain, `the frozen chain disappeared for ${JSON.stringify(path)}`);
  return chain;
}

function matchesAnchor(entry: Entry, anchor: EntryAnchor | null): boolean {
  if (!anchor) return entry.kind === "absent";
  if (entry.kind === "file") return entry.mode === anchor.mode && entry.blob === anchor.sha256;
  return entry.kind === "symlink" && anchor.mode === "120000" && entry.blob === anchor.sha256;
}

function sameAnchor(left: EntryAnchor | null, right: EntryAnchor | null): boolean {
  return left?.mode === right?.mode && left?.sha256 === right?.sha256;
}

function readFrozenBytes(entry: Entry, content: Content): Buffer {
  const bytes = bytesFor(entry, content);
  requireProof(entry.kind === "absent" || ((entry.kind === "file" || entry.kind === "symlink") && hash(bytes) === entry.blob),
    "frozen content did not match its hash");
  return bytes;
}

function matchesGitBlob(bytes: Buffer, oid: string): boolean {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) return false;
  return createHash(oid.length === 40 ? "sha1" : "sha256")
    .update(`blob ${bytes.length}\0`).update(bytes).digest("hex") === oid;
}

interface Range { start: number; end: number }
interface Mapping extends Range { nextStart: number }

function* overlapping<T extends Range>(ranges: readonly T[], start: number, end: number): Generator<T> {
  if (start >= end) return;
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (ranges[mid]!.end <= start) low = mid + 1;
    else high = mid;
  }
  for (let index = low; index < ranges.length && ranges[index]!.start < end; index++) yield ranges[index]!;
}

function lineOffsets(bytes: Buffer): Uint32Array {
  const offsets = new Uint32Array(lineCount(bytes) + 1);
  let line = 0;
  for (let index = 0; index < bytes.length; index++) if (bytes[index] === 10) offsets[++line] = index + 1;
  offsets[offsets.length - 1] = bytes.length;
  return offsets;
}

function hunkKey({ kind, range }: Pick<SelectedHunk, "kind" | "range">): string {
  return JSON.stringify([kind, range?.oldStart, range?.oldCount, range?.newStart, range?.newCount]);
}

function layout(before: Buffer, after: Buffer, hunks: readonly SelectedHunk[]) {
  const oldOffsets = lineOffsets(before);
  const currentOffsets = lineOffsets(after);
  const retained: Mapping[] = [];
  const selected: Mapping[] = [];
  const parts: Buffer[] = [];
  let oldCursor = 0;
  let currentCursor = 0;
  let next = 0;
  const keep = (end: number) => {
    if (end === oldCursor) return;
    retained.push({ start: oldCursor, end, nextStart: next });
    parts.push(before.subarray(oldOffsets[oldCursor], oldOffsets[end]));
    next += end - oldCursor;
  };
  for (const hunk of hunks) {
    const { kind, range, beforeSha256, afterSha256 } = hunk;
    if (kind !== "content") {
      requireProof(!range && beforeSha256 === undefined && afterSha256 === undefined, "invalid entry property evidence");
      continue;
    }
    requireProof(range && [range.oldStart, range.oldCount, range.newStart, range.newCount].every(Number.isSafeInteger) &&
      range.oldStart >= oldCursor && range.newStart >= currentCursor && range.oldCount >= 0 && range.newCount >= 0 &&
      range.oldCount + range.newCount > 0, "invalid selected line range");
    const { oldStart, oldCount, newStart, newCount } = range;
    const oldEnd = oldStart + oldCount;
    const currentEnd = newStart + newCount;
    requireProof(oldEnd < oldOffsets.length && currentEnd < currentOffsets.length, "selected line range exceeds the frozen bytes");
    const removed = before.subarray(oldOffsets[oldStart], oldOffsets[oldEnd]);
    const inserted = after.subarray(currentOffsets[newStart], currentOffsets[currentEnd]);
    requireProof(hash(removed) === beforeSha256 && hash(inserted) === afterSha256, "selected line bytes changed");
    keep(oldStart);
    if (newCount) {
      selected.push({ start: newStart, end: currentEnd, nextStart: next });
      parts.push(inserted);
      next += newCount;
    }
    oldCursor = oldEnd;
    currentCursor = currentEnd;
  }
  keep(oldOffsets.length - 1);
  const bytes = Buffer.concat(parts);
  requireProof(lineCount(bytes) === next, "selected lines cannot be placed independently");
  return { bytes, retained, selected };
}

function verifyHunks(
  chain: Chain, annotation: Annotation, path: SelectedPath, kind: PinnedPath["kind"], independentMode: boolean, content: Content,
) {
  const expected = uniqueIndex(hunkOwnership(chain.base, tip(chain), annotation, content, path.path), hunkKey);
  const selected = uniqueIndex(path.hunks, hunkKey);
  requireProof(selected.size > 0 && sameMembers(annotation.moves, path.moves), "the frozen hunk or move evidence changed");
  const allTies = new Set(path.hunks.flatMap(({ ties }) => ties));
  for (const [key, hunk] of expected) {
    const evidence = selected.get(key);
    if (!evidence) {
      const canOmit = kind === "partial" || (independentMode && hunk.kind === "mode");
      requireProof(canOmit && hunk.ownership.ties.every((tie) => !allTies.has(tie)), "selection omits tied ownership");
      continue;
    }
    requireProof(hunk.kind !== "opaque" && sameMembers(hunk.ownership.owners, evidence.executionIds) &&
      sameMembers(hunk.ownership.ties, evidence.ties), "the frozen hunk owners or ties changed");
    selected.delete(key);
  }
  requireProof(!selected.size, "a selected hunk is missing from the ledger");
}

function expectedFrozen(path: SelectedPath, kind: PinnedPath["kind"], independentMode: boolean, edited: Buffer): EntryAnchor | null {
  const selected = new Set(path.hunks.map(({ kind: member }) => member));
  const baseMode = path.base?.mode ?? "100644";
  if (kind === "whole") {
    if (independentMode && !selected.has("mode") && path.working) return { ...path.working, mode: baseMode };
    return path.working;
  }
  requireProof(path.working && path.working.mode !== "120000" && path.base?.mode !== "120000" &&
    (path.base || selected.has("presence")) && (!path.base || path.base.rawSha256 === path.base.sha256) && !selected.has("type"),
  "partial selection cannot reproduce the frozen entry");
  const mode = selected.has("mode") ? path.working.mode : baseMode;
  return { mode, sha256: hash(edited) };
}

function mapRange(range: Range, retained: readonly Mapping[]): Range[] {
  return [...overlapping(retained, range.start, range.end)].map(({ start, end, nextStart }) => ({
    start: Math.max(range.start, start) - start + nextStart,
    end: Math.min(range.end, end) - start + nextStart,
  }));
}

function updateAnnotation(annotation: Annotation, { retained, selected }: ReturnType<typeof layout>, presenceSelected: boolean): Annotation {
  const other = { owners: [null], ties: [] };
  const lines: Annotation["lines"] = selected.map(({ start, end, nextStart }) => ({
    start, end, value: { baseStart: nextStart, by: other, replaced: [] },
  }));
  for (const span of annotation.lines) {
    const { baseStart, by, replaced } = span.value;
    const remaining = replaced.flatMap((range) => mapRange(range, retained));
    const keep = (start: number, end: number) => {
      if (start >= end) return;
      if (baseStart === undefined) {
        lines.push({ start, end, value: { by, replaced: remaining } });
        return;
      }
      const oldStart = baseStart + start - span.start;
      let cursor = start;
      for (const range of mapRange({ start: oldStart, end: oldStart + end - start }, retained)) {
        const length = range.end - range.start;
        lines.push({ start: cursor, end: cursor + length, value: { baseStart: range.start, by, replaced: remaining } });
        cursor += length;
      }
      requireProof(cursor === end, "a selected base range also anchors an unselected working line");
    };
    let cursor = span.start;
    for (const range of overlapping(selected, span.start, span.end)) {
      keep(cursor, range.start);
      cursor = Math.min(span.end, range.end);
    }
    keep(cursor, span.end);
  }
  lines.sort((a, b) => a.start - b.start);
  const tombstones = annotation.tombstones.flatMap(({ start, end, value }) =>
    mapRange({ start, end }, retained).map((range) => ({ ...range, value })));
  return { lines, tombstones, presence: presenceSelected ? other : annotation.presence, moves: annotation.moves };
}

function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

function verifySelectedPath(chain: Chain, selected: SelectedPath, kind: PinnedPath["kind"], content: Content) {
  const { base, working } = selected;
  const current = tip(chain);
  requireProof(matchesAnchor(chain.base, base) && matchesAnchor(current, working), "the frozen entry changed");
  const annotation = annotate(chain, content);
  const before = readFrozenBytes(chain.base, content);
  const after = readFrozenBytes(current, content);
  // For new or empty regular entries, whole conversion can write all selected content
  // while the working tree's separately observed chmod stays unselected.
  const independentMode = !selected.moves.length && current.kind === "file" &&
    (chain.base.kind === "absent" || (chain.base.kind === "file" && !before.length));
  verifyHunks(chain, annotation, selected, kind, independentMode, content);
  if (base && base.rawSha256 === base.sha256) {
    requireProof(matchesGitBlob(before, base.oid), "frozen base blob did not match Git");
  }
  const edited = layout(before, after, selected.hunks);
  requireProof(kind !== "whole" || edited.bytes.equals(after), "whole entry evidence omits working content");
  const expected = expectedFrozen(selected, kind, independentMode, edited.bytes);
  requireProof(sameAnchor(expected, selected.frozen), "the frozen commit entry changed");
  if (kind === "partial") {
    requireProof(!selected.moves.length, "a move requires whole entries");
    // Reject a partially selected repeated range if it also anchors an unselected line.
    updateAnnotation(annotation, edited, selected.hunks.some(({ kind }) => kind === "presence"));
  }
  return { expected, independentMode };
}

/** Pin and verify selected-path custody before Git can publish. Hold new ledger events until settlement. */
export function pinCommitOwnership(
  snapshot: CommitOwnershipSnapshot, frozen: FrozenCommitSelection<CommitOwnershipReceipt>, content: Content,
): CommitOwnershipPlan {
  const receipt = structuredClone(frozen.ownership);
  checkSnapshot(snapshot, receipt);
  const entries = uniqueIndex(frozen.entries, ({ path }) => path);
  const components = uniqueIndex(frozen.components, ({ id }) => id);
  const pathsByComponent = new Map<string, Set<string>>();
  const moves = new Map<string, { path: string; componentId: string }[]>();
  requireProof(receipt.generation === frozen.generation && sameMembers(receipt.componentIds, [...components.keys()]) &&
    entries.size > 0 && sameMembers(receipt.paths.map(({ path }) => path), [...entries.keys()]), "the frozen selection changed");
  const paths = receipt.paths.map((selected) => {
    const { path } = selected;
    const chain = selectedChain(snapshot, path);
    const entry = entries.get(path)!;
    const { expected, independentMode } = verifySelectedPath(chain, selected, entry.kind, content);
    requireProof(sameAnchor(expected, entry.content && { mode: entry.mode, sha256: hash(entry.content) }), "the frozen commit entry changed");
    const ids = new Set(selected.hunks.map(({ componentId }) => componentId));
    const wholeComponents = new Set(selected.hunks.flatMap(({ componentId, kind }) =>
      independentMode && kind === "mode" ? [] : [componentId]));
    requireProof(entry.kind !== "whole" || ids.size === 1 || (wholeComponents.size === 1 && ids.size === 2),
      "a whole entry spans multiple components");
    for (const id of ids) {
      const members = pathsByComponent.get(id) ?? new Set<string>();
      members.add(path);
      pathsByComponent.set(id, members);
    }
    for (const move of selected.moves) {
      const endpoints = moves.get(move) ?? [];
      endpoints.push({ path, componentId: selected.hunks[0]!.componentId });
      moves.set(move, endpoints);
    }
    return { path, kind: entry.kind, chainSha256: digest(chain) };
  });
  requireProof(pathsByComponent.size === components.size && [...components].every(([id, { paths }]) =>
    sameMembers(paths, [...(pathsByComponent.get(id) ?? [])])), "the selected component paths changed");
  for (const endpoints of moves.values()) {
    requireProof(endpoints.length === 2 && endpoints[0]!.path !== endpoints[1]!.path &&
      endpoints[0]!.componentId === endpoints[1]!.componentId, "a selected move is missing an endpoint");
  }
  return immutable({ version: 1, receipt, paths, sha256: digest([receipt, paths]) });
}

/** A later report may explain an observed gap without changing the selected evidence or frozen bytes. */
export function verifyLateCommitEdit(
  plan: CommitOwnershipPlan, path: string, chain: Chain, content: Content,
): CommitOwnershipPlan | undefined {
  const { receipt, paths } = plan;
  const index = paths.findIndex((item) => item.path === path);
  if (index < 0) return;
  const pinned = paths[index]!;
  try {
    verifySelectedPath(chain, receipt.paths[index]!, pinned.kind, content);
  } catch (error) {
    if (error instanceof CommitOwnershipError) return;
    throw error;
  }
  const updated = paths.with(index, { ...pinned, chainSha256: digest(chain) });
  return immutable({ version: 1, receipt, paths: updated, sha256: digest([receipt, updated]) });
}

function publishedEntry(
  raw: Buffer | null, working: ReadEntry, next: GitTreeEntry | null, frozen: EntryAnchor | null, kind: PinnedPath["kind"],
): { entry: Exclude<Entry, { kind: "opaque" }>; bytes: Buffer | null } {
  if (!next) {
    requireProof(raw === null && working.kind === "absent" && frozen === null, "published deletion evidence changed");
    return { entry: ABSENT, bytes: null };
  }
  requireProof(frozen && next.mode === frozen.mode && raw && matchesGitBlob(raw, next.oid), "published blob or mode changed");
  requireProof((working.kind === "file" && working.mode === next.mode) || (working.kind === "symlink" && next.mode === "120000"),
    "the committed working form has a different entry kind or mode");
  const bytes = Buffer.from(working.bytes);
  const blob = hash(bytes);
  if (kind === "partial" || working.kind === "symlink") {
    requireProof(blob === frozen.sha256 && raw.equals(bytes), "identity content differs from the published blob");
  }
  const entry: Exclude<Entry, { kind: "opaque" }> = working.kind === "symlink" ? { kind: "symlink", blob } : { kind: "file", mode: working.mode, blob };
  return { entry, bytes };
}

type CandidateOwnership = Omit<CommitSettlement<CommitOwnershipPlan>, "phase" | "evidence" | "receipt">;

function ownershipUpdates(
  snapshot: CommitOwnershipSnapshot, record: CandidateOwnership,
  proof: PublishedBaseEvidence, content: Content,
): CommitOwnershipUpdate[] {
  const { ownership: plan, head, request, project, commit } = record;
  const { receipt, paths } = plan;
  requireProof(plan.version === 1 && plan.sha256 === digest([receipt, paths]), "the pinned receipt changed");
  checkSnapshot(snapshot, receipt);
  requireProof(proof.commit === commit && sameHead(head, receipt.head) &&
    project.id === receipt.projectId && project.root === receipt.scope.worktreeRoot && request.projectId === project.id &&
    request.generation === receipt.generation && sameMembers(request.componentIds, receipt.componentIds), "publication does not match the pinned selection");
  const verified = uniqueIndex(proof.paths, ({ path }) => path);
  const entries = uniqueIndex(record.entries, ({ path }) => path);
  requireProof(sameMembers(paths.map(({ path }) => path), [...verified.keys()]) &&
    sameMembers(paths.map(({ path }) => path), [...entries.keys()]), "published paths differ from the pinned selection");
  return paths.map(({ path, kind, chainSha256 }, index) => {
    const original = selectedChain(snapshot, path);
    const selected = receipt.paths[index]!;
    const { base, next } = entries.get(path)!;
    const { raw, working } = verified.get(path)!;
    requireProof(path === selected.path && chainSha256 === digest(original), `the frozen chain changed for ${JSON.stringify(path)}`);
    requireProof(base?.mode === selected.base?.mode && base?.oid === selected.base?.oid, "the published commit has a different parent entry");
    const { entry, bytes } = publishedEntry(raw, working, next, selected.frozen, kind);
    const current = tip(original);
    let anchor: Annotation;
    if (kind === "partial") {
      const edited = layout(readFrozenBytes(original.base, content), readFrozenBytes(current, content), selected.hunks);
      anchor = updateAnnotation(annotate(original, content), edited, selected.hunks.some(({ kind }) => kind === "presence"));
    } else {
      const workingContent: Content = {
        get: (blob) => entry.kind !== "absent" && entry.blob === blob ? bytes! : content.get(blob),
        put: () => { throw new CommitOwnershipError("unexpected content write"); },
      };
      // Clean/smudge can leave a residual diff even when the entire frozen working entry was selected.
      anchor = applyLink(initialAnnotation(entry, workingContent), entry, current, workingContent);
    }
    return { path, baseBytes: bytes, chain: structuredClone({ base: entry, anchor, versions: [{ entry: current }] }) };
  });
}

/** Verify the exact candidate while it is still safe to refuse publication. */
export function validateCommitOwnershipCandidate(
  snapshot: CommitOwnershipSnapshot, record: CandidateOwnership, proof: PublishedBaseEvidence, content: Content,
): void {
  ownershipUpdates(snapshot, record, proof, content);
}

/** Return selected-path updates only. Apply all updates and the done journal record atomically. */
export function settleCommitOwnership(
  snapshot: CommitOwnershipSnapshot, record: Omit<CommitSettlement<CommitOwnershipPlan>, "receipt">,
  proof: PublishedBaseEvidence, content: Content,
): CommitOwnershipUpdate[] {
  requireProof(record.evidence === "published", "publication does not match the pinned selection");
  return ownershipUpdates(snapshot, record, proof, content);
}
