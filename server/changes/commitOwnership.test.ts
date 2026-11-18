import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { insert, inspect, newChain, observe, place, tip, type Chain } from "./chain.ts";
import {
  pinCommitOwnership, settleCommitOwnership, type CommitOwnershipPlan, type CommitOwnershipReceipt,
  type CommitOwnershipUpdate, type PublishedBaseEvidence,
} from "./commitOwnership.ts";
import type { CommitSettlement, FrozenCommitSelection } from "./commitTransaction.ts";
import { ABSENT, bytesFor, storeEntry, type Content, type Entry, type FileMode, type ReadEntry } from "./entries.ts";
import type { FrozenGitEntry } from "./gitTree.ts";
import { hash } from "./persistence.ts";

const head = { branch: "refs/heads/main", oid: "b".repeat(40) };
const scope = { worktreeRoot: "/repo", projectDir: "/repo" };
const commit = "c".repeat(40);
const projectId = "test-project";

function blobOid(bytes: Buffer): string {
  return createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
}

function file(text: string, mode: FileMode = "100644"): ReadEntry {
  return { kind: "file", mode, bytes: Buffer.from(text) };
}

function symlink(target: string): ReadEntry {
  return { kind: "symlink", bytes: Buffer.from(target) };
}

function offsets(bytes: Buffer): number[] {
  const ends = [0];
  for (const [index, byte] of bytes.entries()) if (byte === 10) ends.push(index + 1);
  if (ends.at(-1) !== bytes.length) ends.push(bytes.length);
  return ends;
}

type Selection = {
  path: string;
  frozen: ReadEntry;
  kind?: FrozenGitEntry["kind"];
  componentId?: string;
  owners?: readonly (string | null)[];
  oldRaw?: string;
};

function anchor(item: Entry) {
  if (item.kind === "file") return { mode: item.mode, sha256: item.blob };
  return item.kind === "symlink" ? { mode: "120000" as const, sha256: item.blob } : null;
}

function fixture() {
  const blobs = new Map<string, Buffer>();
  const content: Content = {
    put: (bytes) => { const key = hash(bytes); blobs.set(key, Buffer.from(bytes)); return key; },
    get: (key) => {
      const bytes = blobs.get(key);
      if (!bytes) throw new Error("Missing test content " + key);
      return bytes;
    },
  };
  const chains = new Map<string, Chain>();
  const pendingPaths = new Set<string>();
  const snapshot = { projectId, scope, head, chains, pendingPaths };
  const entry = (value: ReadEntry) => storeEntry(value, content);
  function track(path: string, base: ReadEntry = ABSENT) {
    const chain = newChain(entry(base), content);
    chains.set(path, chain);
    return chain;
  }
  function edit(chain: Chain, writer: string, after: string | null, move?: string) {
    const current = tip(chain);
    if (current.kind !== "file" && current.kind !== "absent") throw new Error("Test expects a regular file or absence");
    const from = current.kind === "file" ? current.blob : null;
    const to = after === null ? null : content.put(Buffer.from(after));
    const placement = place(chain, { from, to }, content);
    if (!placement || typeof placement === "string") throw new Error("Test edit did not link");
    insert(chain, placement, { executionId: writer, key: writer + chain.versions.length, move });
  }
  function selection(...selections: Selection[]): FrozenCommitSelection<CommitOwnershipReceipt> {
    const entries: FrozenGitEntry[] = [];
    const membership = new Map<string, string[]>();
    const paths = selections.map(({ path, frozen, kind = "partial", componentId = path, owners, oldRaw }) => {
      const { base, current, hunks, moves } = inspect(chains.get(path)!, path, content);
      const oldBytes = bytesFor(base, content);
      const workingBytes = bytesFor(current, content);
      const raw = oldRaw === undefined ? oldBytes : Buffer.from(oldRaw);
      const oldOffsets = offsets(oldBytes);
      const currentOffsets = offsets(workingBytes);
      const baseAnchor = anchor(base);
      const frozenAnchor = anchor(entry(frozen));
      if (frozen.kind === "absent") entries.push({ path, kind: "whole", mode: "0", content: null });
      else if ("bytes" in frozen) entries.push({ path, kind, mode: frozenAnchor!.mode, content: frozen.bytes });
      else throw new Error("Test requires a readable frozen entry");
      membership.set(componentId, [...(membership.get(componentId) ?? []), path]);
      return {
        path, base: baseAnchor && { ...baseAnchor, rawSha256: hash(raw), oid: blobOid(raw) }, working: anchor(current),
        frozen: frozenAnchor, moves,
        hunks: hunks.filter(({ ownership }) => !owners || ownership.owners.every((writer) => owners.includes(writer)))
          .map(({ kind, range, ownership }) => ({
            componentId, kind, range, executionIds: ownership.owners, ties: ownership.ties,
            beforeSha256: range && hash(oldBytes.subarray(oldOffsets[range.oldStart], oldOffsets[range.oldStart + range.oldCount])),
            afterSha256: range && hash(workingBytes.subarray(currentOffsets[range.newStart], currentOffsets[range.newStart + range.newCount])),
          })),
      };
    });
    return {
      generation: 7, entries, workingWriterIds: [],
      components: [...membership].map(([id, paths]) => ({ id, paths, writerIds: [], other: false, incomplete: false })),
      ownership: { version: 1, projectId, scope, head, generation: 7, componentIds: [...membership.keys()], paths },
    };
  }
  function publication(plan: CommitOwnershipPlan, paths: PublishedBaseEvidence["paths"]) {
    const entries = plan.receipt.paths.map(({ path, base, frozen }) => ({
      path, base: base && { mode: base.mode, oid: base.oid },
      next: frozen && { mode: frozen.mode, oid: blobOid(paths.find((item) => item.path === path)!.raw!) },
    }));
    const record: CommitSettlement<CommitOwnershipPlan> = {
      project: { id: projectId, root: scope.worktreeRoot, commonDir: "/repo/.git" },
      request: {
        projectId, jobId: "job", message: "commit", generation: plan.receipt.generation, componentIds: plan.receipt.componentIds,
        writerIds: [], selection: { kind: "explicit", otherComponentIds: [] },
      },
      pid: 1, head, tree: "tree", commit, entries, indexPath: "/repo/.git/index", lock: { device: "1", inode: "2" },
      ownership: plan, phase: "done", receipt: { kind: "acknowledged" }, evidence: "published",
    };
    return { record, proof: { commit, paths } };
  }
  const pin = (frozen: FrozenCommitSelection<CommitOwnershipReceipt>) => pinCommitOwnership(snapshot, frozen, content);
  const settle = ({ record, proof }: ReturnType<typeof publication>) => settleCommitOwnership(snapshot, record, proof, content);
  const install = ({ baseBytes, chain, path }: CommitOwnershipUpdate) => {
    if (baseBytes) content.put(baseBytes);
    chains.set(path, chain);
    return chain;
  };
  return { chains, content, pendingPaths, track, edit, entry, selection, publication, pin, settle, install };
}

function published(path: string, working: ReadEntry, raw?: string): PublishedBaseEvidence["paths"][number] {
  return { path, raw: raw === undefined ? "bytes" in working ? working.bytes : null : Buffer.from(raw), working };
}

describe("settling ownership for Vizzo's published commits", () => {
  it("preserves independent edits and removals by another writer on the same file", () => {
    const { chains, content, track, edit, selection, publication, pin, settle, install } = fixture();
    const original = track("f", file("a-head\nanchor-a\nremove-a\nmiddle\nremove-b\nanchor-b\nb-tail\n"));
    const unrelated = track("other", file("base\n"));
    edit(unrelated, "B", "other\n");
    const text = "new-a1\nnew-a2\nnew-a3\nanchor-a\nmiddle\nremove-b\nanchor-b\nb-tail\n";
    edit(original, "A", text);
    edit(original, "B", "new-a1\nnew-a2\nnew-a3\nanchor-a\nmiddle\nanchor-b\nnew-b\n");
    const previous = inspect(original, "f", content).hunks.filter(({ ownership }) => ownership.owners.includes("B"));
    const plan = pin(selection({ path: "f", frozen: file(text), owners: ["A"] }));
    const updates = settle(publication(plan, [published("f", file(text))]));
    expect(updates.map(({ path }) => path)).toEqual(["f"]);
    expect(chains.get("f")).toBe(original);
    const remaining = install(updates[0]!);
    expect(chains.get("other")).toBe(unrelated);
    expect(remaining.anchor.tombstones.map(({ start, end }) => [start, end])).toEqual([[5, 6], [7, 8]]);
    expect(remaining.anchor.lines.at(-1)!.value.replaced).toEqual([{ start: 7, end: 8 }]);
    expect(inspect(remaining, "f", content).hunks).toEqual(previous.map((hunk) => ({
      ...hunk, range: { ...hunk.range!, oldStart: hunk.range!.oldStart + 1 },
    })));
  });

  it("verifies both owners and their ties when one writer rewrites another writer's line", () => {
    const { track, content, edit, selection, publication, pin, settle, install } = fixture();
    const original = track("f", file("first\nspacer\ntail\n"));
    edit(original, "A", "one\nspacer\ntail\n");
    edit(original, "B", "two\nspacer\ntail\n");
    edit(original, "C", "two\nspacer\nnew-tail\n");
    const bytes = file("two\nspacer\ntail\n");
    const frozen = selection({ path: "f", frozen: bytes, owners: ["A", "B"] });
    const path = frozen.ownership.paths[0]!;
    const hunk = path.hunks[0]!;
    expect(hunk.executionIds).toEqual(["A", "B"]);
    expect(hunk.ties).toHaveLength(2);
    expect(() => pin({ ...frozen, ownership: { ...frozen.ownership, paths: [{ ...path, hunks: [{ ...hunk, executionIds: ["A"] }] }] } }))
      .toThrow("owners or ties changed");
    const [remaining] = settle(publication(pin(frozen), [published("f", bytes)])).map(install);
    expect(inspect(remaining!, "f", content).hunks.map(({ ownership }) => ownership.owners)).toEqual([["C"]]);
  });

  it("settles creation and text while retaining an unselected executable bit as Other", () => {
    const { track, entry, content, edit, selection, publication, pin, settle, install } = fixture();
    const original = track("new");
    edit(original, "A", "created\n");
    observe(original, entry(file("created\n", "100755")));
    const frozen = file("created\n");
    const plan = pin(selection({ path: "new", frozen, owners: ["A"] }));
    const [remaining] = settle(publication(plan, [published("new", frozen)])).map(install);
    expect(remaining!.base).toMatchObject({ kind: "file", mode: "100644" });
    expect(tip(remaining!)).toMatchObject({ kind: "file", mode: "100755" });
    expect(inspect(remaining!, "new", content).hunks).toEqual([{ kind: "mode", ownership: { owners: [null], ties: [] } }]);
  });

  it.each([false, true])("converts all new content with independent mode selected=%s", (withMode) => {
    const { track, entry, content, edit, selection, publication, pin, settle, install } = fixture();
    const original = track("new");
    edit(original, "A", "created\n");
    observe(original, entry(file("created\n", "100755")));
    const mode = withMode ? "100755" : "100644";
    const frozen = selection({ path: "new", kind: "whole", frozen: file("created\n", mode), owners: withMode ? ["A", null] : ["A"] });
    const path = frozen.ownership.paths[0]!;
    const plan = pin(withMode ? {
      ...frozen,
      components: [...frozen.components, { id: "chmod", paths: ["new"], writerIds: [], incomplete: false, other: true }],
      ownership: {
        ...frozen.ownership, componentIds: ["new", "chmod"],
        paths: [{ ...path, hunks: path.hunks.map((hunk) => hunk.kind === "mode" ? { ...hunk, componentId: "chmod" } : hunk) }],
      },
    } : frozen);
    const [remaining] = settle(publication(plan, [published("new", file("created\r\n", mode), "created\n")])).map(install);
    expect(remaining!.base).toMatchObject({ kind: "file", mode });
    expect(tip(remaining!)).toMatchObject({ kind: "file", mode: "100755" });
    const hunks = inspect(remaining!, "new", content).hunks;
    expect(hunks.map(({ kind }) => kind)).toEqual(withMode ? ["content"] : ["content", "mode"]);
    expect(hunks.flatMap(({ ownership }) => ownership.owners)).toEqual(withMode ? [null] : [null, null]);
  });

  it("reads whole converted and symlink bases from their published objects", () => {
    const { track, entry, content, edit, selection, publication, pin, settle, install } = fixture();
    const converted = track("converted", file("base\r\n"));
    edit(converted, "A", "working\r\n");
    const link = track("link", symlink("old"));
    observe(link, entry(symlink("new")));
    const plan = pin(selection(
      { path: "converted", kind: "whole", frozen: file("working\r\n"), oldRaw: "base\n" },
      { path: "link", kind: "whole", frozen: symlink("new") },
    ));
    const result = publication(plan, [published("converted", file("smudged\r\n"), "cleaned\n"), published("link", symlink("new"))]);
    const [updatedConverted, updatedLink] = settle(result).map(install);
    expect(bytesFor(updatedConverted!.base, content)).toEqual(Buffer.from("smudged\r\n"));
    expect(inspect(updatedConverted!, "converted", content).hunks.map(({ ownership }) => ownership.owners)).toEqual([[null]]);
    expect(inspect(updatedLink!, "link", content).hunks).toEqual([]);
  });

  it("requires both whole move endpoints and clears the selected move from the new annotations", () => {
    const { track, content, edit, selection, publication, pin, settle, install } = fixture();
    const source = track("src", file("move me\n"));
    const target = track("dest");
    edit(source, "A", null, "move-id");
    edit(target, "A", "move me\n", "move-id");
    const from: Selection = { path: "src", kind: "whole", frozen: ABSENT, componentId: "move" };
    const to: Selection = { path: "dest", kind: "whole", frozen: file("move me\n"), componentId: "move" };
    expect(() => pin(selection(from))).toThrow("missing an endpoint");
    const plan = pin(selection(from, to));
    for (const update of settle(publication(plan, [published("src", ABSENT), published("dest", to.frozen)]))) {
      expect(inspect(install(update), update.path, content)).toMatchObject({ moves: [], hunks: [] });
    }
  });

  it("persists an immutable detached plan and returns the same updates on retry", () => {
    const { track, edit, selection, publication, pin, settle } = fixture();
    const original = track("f", file("base\n"));
    edit(original, "A", "published\n");
    const bytes = file("published\n");
    const frozen = selection({ path: "f", frozen: bytes });
    const plan = pin(frozen);
    expect(plan.receipt).not.toBe(frozen.ownership);
    expect(Object.isFrozen(plan.receipt.paths[0]!.hunks[0]!.ties)).toBe(true);
    const journalPlan: CommitOwnershipPlan = JSON.parse(JSON.stringify(plan));
    const review = publication(journalPlan, [published("f", bytes)]);
    expect(settle(review)).toEqual(settle(review));
    expect(() => settle({ ...review, record: { ...review.record, ownership: { ...journalPlan,
      receipt: { ...journalPlan.receipt, generation: 8 },
    } } })).toThrow("pinned receipt changed");
  });

  it("keeps the exact tip for a delayed event and refuses unresolved selected-path receipts", () => {
    const { content, track, edit, selection, publication, pin, settle, install, pendingPaths } = fixture();
    const original = track("f", file("base\n"));
    edit(original, "A", "published\n");
    const bytes = file("published\n");
    const frozen = selection({ path: "f", frozen: bytes });
    pendingPaths.add("f");
    expect(() => pin(frozen)).toThrow("unresolved edit");
    pendingPaths.delete("f");
    pendingPaths.add("unrelated");
    const plan = pin(frozen);
    const evidence = { from: content.put(Buffer.from("published\n")), to: content.put(Buffer.from("late\n")) };
    const [remaining] = settle(publication(plan, [published("f", bytes)])).map(install);
    const placement = place(remaining!, evidence, content);
    if (!placement || typeof placement === "string") throw new Error("Delayed edit lost its preimage");
    insert(remaining!, placement, { executionId: "B", key: "late" });
    expect(inspect(remaining!, "f", content).hunks.map(({ ownership }) => ownership.owners)).toEqual([["B"]]);
  });

  it("fails closed on wrong publication proof and a same-byte ownership change", () => {
    const { chains, content, track, edit, selection, publication, pin, settle } = fixture();
    const original = track("f", file("base\n"));
    edit(original, "A", "published\n");
    const bytes = file("published\n");
    const plan = pin(selection({ path: "f", frozen: bytes }));
    const review = publication(plan, [published("f", bytes)]);
    expect(() => settle({ ...review, proof: { ...review.proof, paths: [published("f", bytes, "wrong blob\n")] } }))
      .toThrow("published blob or mode changed");
    expect(() => settle({ ...review, proof: { ...review.proof, paths: [published("f", file("published\r\n"), "published\n")] } }))
      .toThrow("identity content differs");
    const replacement = newChain(original.base, content);
    edit(replacement, "B", "published\n");
    chains.set("f", replacement);
    expect(tip(original)).toEqual(tip(replacement));
    expect(() => settle(review)).toThrow("frozen chain changed");
    expect(inspect(replacement, "f", content).hunks.map(({ ownership }) => ownership.owners)).toEqual([["B"]]);
  });
});
