import { applyLink, hunkOwnership, initialAnnotation, rebaseAnnotation, type Annotation, type Link } from "./annotations.ts";
import { ABSENT, sameEntry, type Content, type Entry } from "./entries.ts";
import { applyExactPatch, parsePatch, MAX_FILE_BYTES, MAX_VERSIONS } from "./evidence.ts";
import type { HunkRange } from "./lineDiff.ts";

type Version = { entry: Entry; link?: Link; observed?: true };

export interface Chain {
  base: Entry;
  anchor: Annotation;
  versions: [Version, ...Version[]];
}

export type FileEvidence =
  | { from: string | null; to: string | null }
  | { patch: string; patchPath: string; deletion: boolean };

export function newChain(base: Entry, content: Content): Chain {
  return { base, anchor: initialAnnotation(base, content), versions: [{ entry: base }] };
}

export function tip(chain: Chain): Entry {
  return chain.versions.at(-1)!.entry;
}

type Placement = { from: number; after: Entry; rejoin?: number; reconnect?: number; ranges?: HunkRange[] };
export type PlacementResult = Placement | "too-large" | "ambiguous" | undefined;

function linkPlacement(chain: Chain, from: number, after: Entry, ranges?: HunkRange[]): PlacementResult {
  if (sameEntry(chain.versions[from]!.entry, after)) return { from, after };
  if (chain.versions[from + 1]?.link) {
    // A full preimage can witness a return to this version. Reconnect only if a later
    // independently observed gap is exactly the reported result. A patch cannot prove the return.
    if (ranges) return;
    let reconnect: number | undefined;
    for (let candidate = from + 2; candidate < chain.versions.length; candidate++) {
      const node = chain.versions[candidate]!;
      if (node.entry.kind === "opaque" || node.entry.kind === "symlink") break;
      const matching = sameEntry(after, node.entry) ||
        (after.kind === "file" && node.entry.kind === "file" && after.blob === node.entry.blob);
      if (!node.link && node.observed && matching) reconnect = candidate;
    }
    return reconnect === undefined ? undefined : { from, after, reconnect };
  }
  let rejoin: number | undefined;
  for (let candidate = from + 1; candidate < chain.versions.length; candidate++) {
    const node = chain.versions[candidate]!;
    if (node.link || node.entry.kind === "opaque" || node.entry.kind === "symlink") break;
    if (sameEntry(after, node.entry)) rejoin = candidate;
  }
  return { from, after, rejoin, ranges };
}

export function place(chain: Chain, evidence: FileEvidence, content: Content): PlacementResult {
  if ("patch" in evidence) {
    const patch = parsePatch(evidence.patchPath, content.get(evidence.patch).toString("utf8"));
    if (!patch) return;
    let matched: { index: number; applied: Buffer; entry: Extract<Entry, { kind: "file" }> } | undefined;
    for (const [index, { entry }] of chain.versions.entries()) {
      if (entry.kind !== "file") continue;
      const applied = applyExactPatch(content.get(entry.blob), patch, evidence.deletion);
      if (!applied) continue;
      if (matched) return "ambiguous";
      matched = { index, applied, entry };
    }
    if (!matched) return;
    if (matched.applied.length > MAX_FILE_BYTES) return "too-large";
    const after = evidence.deletion ? ABSENT : { ...matched.entry, blob: content.put(matched.applied) };
    return linkPlacement(chain, matched.index, after, patch.flatMap(({ edits }) => edits));
  }
  for (let index = chain.versions.length - 1; index >= 0; index--) {
    const { entry: before } = chain.versions[index]!;
    if (evidence.from === null ? before.kind !== "absent" : before.kind !== "file" || before.blob !== evidence.from) continue;
    const after: Entry = evidence.to === null ? ABSENT : {
      kind: "file", mode: before.kind === "file" ? before.mode : "100644", blob: evidence.to,
    };
    return linkPlacement(chain, index, after);
  }
}

export function insert(chain: Chain, placement: Placement, source: Link): void {
  const link = placement.ranges ? { ...source, ranges: placement.ranges } : source;
  if (sameEntry(chain.versions[placement.from]!.entry, placement.after)) return;
  if (placement.reconnect !== undefined) {
    const observed = chain.versions[placement.reconnect]!;
    const exact = sameEntry(observed.entry, placement.after);
    chain.versions.splice(placement.reconnect, Number(exact),
      { entry: chain.versions[placement.from]!.entry },
      { entry: placement.after, link, observed: exact ? observed.observed : undefined },
    );
    return;
  }
  const observed = placement.rejoin === undefined ? undefined : chain.versions[placement.rejoin]!.observed;
  chain.versions.splice(placement.from + 1,
    placement.rejoin === undefined ? 0 : placement.rejoin - placement.from,
    { entry: placement.after, link, observed },
  );
}

export function observe(chain: Chain, entry: Entry): void {
  const previous = tip(chain);
  if (sameEntry(previous, entry) ||
      (previous.kind === "opaque" && entry.kind === "opaque" && previous.reason === entry.reason)) {
    chain.versions.at(-1)!.observed = true;
    return;
  }
  chain.versions.push({ entry, observed: true });
}

export function annotate(chain: Chain, content: Content, end = chain.versions.length - 1): Annotation {
  const versions = chain.versions;
  let annotation = chain.anchor;
  for (let index = 1; index <= end; index++) {
    const source = versions[index - 1]!.entry;
    let destination = versions[index]!;
    // Keep intermediate gap witnesses available for arriving links. Blame an uninterrupted
    // gap by its endpoints, so a byte-identical retype retains the existing label.
    while (!destination.link && destination.entry.kind !== "opaque" && destination.entry.kind !== "symlink" &&
        !sameEntry(destination.entry, chain.base) && index < end) {
      const next = versions[index + 1]!;
      if (next.link || next.entry.kind === "opaque" || next.entry.kind === "symlink") break;
      destination = next;
      index++;
    }
    annotation = sameEntry(destination.entry, chain.base)
      ? initialAnnotation(chain.base, content)
      : applyLink(annotation, source, destination.entry, content, destination.link);
  }
  return annotation;
}

export function compact(chain: Chain, content: Content): void {
  const gap = chain.versions.findIndex((version, index) => index > 0 && !version.link);
  const end = gap < 0 ? chain.versions.length - 1 : gap - 1;
  if (end === 0) return;
  chain.anchor = annotate(chain, content, end);
  chain.versions = [
    { entry: chain.versions[end]!.entry, observed: chain.versions[end]!.observed },
    ...chain.versions.slice(end + 1),
  ];
}

/** Keep the explained prefix and reduce an oversized unresolved suffix to a single Other gap. */
export function boundVersions(chain: Chain, content: Content): boolean {
  if (chain.versions.length <= MAX_VERSIONS) return false;
  const gap = chain.versions.findIndex((version, index) => index > 0 && !version.link);
  if (gap < 0) compact(chain, content);
  else {
    chain.anchor = annotate(chain, content, gap - 1);
    chain.versions = [
      { entry: chain.versions[gap - 1]!.entry },
      { entry: tip(chain), observed: chain.versions.at(-1)!.observed },
    ];
  }
  return gap >= 0;
}

export function changeBase(chain: Chain, base: Entry, content: Content): void {
  const entry = tip(chain);
  chain.anchor = rebaseAnnotation(base, entry, annotate(chain, content), content);
  chain.base = base;
  chain.versions = [{ entry }];
}

export function inspect(chain: Chain, path: string, content: Content) {
  const current = tip(chain);
  const annotation = annotate(chain, content);
  return {
    path, base: chain.base, current, moves: annotation.moves,
    hunks: hunkOwnership(chain.base, current, annotation, content, path),
  };
}
