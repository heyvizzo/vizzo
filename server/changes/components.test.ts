import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rename, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeRange } from "../../shared/changes.ts";
import {
  buildChangeComponents, changeWriterId, freezeChangeSelection, getComponentDiff,
  type ChangeComponentGraph, type ChangeComponentInput,
} from "./components.ts";
import type { CommitRequest } from "./commitTransaction.ts";
import { GIT_SCAN_MAX_FILE_BYTES, scanGitChanges, type GitScanEntry, type GitScanHead } from "./gitScan.ts";
import { buildCommitTree } from "./gitTree.ts";

const writerA = { kind: "thread", id: "a" } as const;
const writerB = { kind: "thread", id: "b" } as const;
const centralA = { kind: "central", id: "a" } as const;
const jobA = { kind: "job", id: "a" } as const;
const a = changeWriterId(writerA);
const b = changeWriterId(writerB);
const baseHead = { branch: "refs/heads/main", oid: "1".repeat(40) };
const alternateHead = { ...baseHead, oid: "2".repeat(40) };
type Record = ChangeComponentInput["writers"]["executions"][number];
type LedgerFile = ChangeComponentInput["ledger"]["files"][number];
type Hunk = LedgerFile["hunks"][number];
type Mode = "100644" | "100755" | "120000";
type Entry = { mode: Mode; bytes: Buffer };

function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function blob(bytes: Buffer): string {
  return createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
}

function file(bytes: Buffer | string, mode: Mode = "100644"): Entry {
  return { mode, bytes: Buffer.from(bytes) };
}

function ledgerEntry(entry: Entry | null): LedgerFile["base"] {
  if (!entry) return { kind: "absent" };
  if (entry.mode === "120000") return { kind: "symlink", blob: hash(entry.bytes) };
  return { kind: "file", mode: entry.mode, blob: hash(entry.bytes) };
}

function evidence(path: string, base: Entry | null, current: Entry | null, hunks: readonly Hunk[], moves: readonly string[] = []): LedgerFile {
  return { path, base: ledgerEntry(base), current: ledgerEntry(current), hunks, moves };
}

function hunk(range: ChangeRange, owners: (string | null)[], ties: string[] = []): Hunk {
  return { kind: "content", range, ownership: { owners, ties } };
}

function changed(line: number, owners: (string | null)[], ties: string[] = []): Hunk {
  return hunk({ oldStart: line, newStart: line, oldCount: 1, newCount: 1 }, owners, ties);
}

function metadata(kind: "presence" | "mode" | "type", owners: (string | null)[]): Hunk {
  return { kind, ownership: { owners, ties: [] } };
}

const clearAttributes = { filter: null, ident: null, "working-tree-encoding": null, diff: null };

function gitEntry(path: string, base: Entry | null, current: Entry | null, options: Partial<GitScanEntry> = {}): GitScanEntry {
  return {
    path, projectPath: path, pathBytes: Buffer.from(path), status: [],
    base: base && { mode: base.mode, oid: blob(base.bytes), raw: base.bytes, working: base.bytes, workingSha256: hash(base.bytes) },
    current: current && { ...current, sha256: hash(current.bytes) },
    attributes: { base: clearAttributes, current: clearAttributes }, conversion: "identity",
    wholeEntryReason: null, otherReason: null, ...options,
  };
}

function record(executionId: string, writer = writerA as Record["writer"], options: Partial<Record> = {}): Record {
  return { executionId, writer, title: writer.id, phase: "settled", pending: false, outcome: "completed", ...options };
}

function input(entries: GitScanEntry[], files: LedgerFile[], options: Partial<ChangeComponentInput> = {}): ChangeComponentInput {
  return {
    projectId: "project", scope: { worktreeRoot: "/repo", projectDir: "/repo" }, head: baseHead, generation: 1,
    git: { entries }, ledger: { head: baseHead, headMoved: false, files, snapshots: files },
    writers: { projectId: "project", executions: [record("a"), record("a2"), record("b", writerB)] },
    ...options,
  };
}

const one = file("original\n");
const two = file("updated\n");
const before = file("base A\nseparator\nbase B");
const after = file("new A\nseparator\nnew B");
const splitEvidence = evidence("example", before, after, [changed(0, ["a"]), changed(2, ["b"])]);

function request(
  graph: ChangeComponentGraph, componentIds: readonly string[], writerIds: string[],
  selection: CommitRequest["selection"] = { kind: "explicit", otherComponentIds: [] },
) {
  return { projectId: graph.review.projectId, generation: graph.view.generation, componentIds, writerIds, selection };
}

function select(graph: ChangeComponentGraph, componentIds: readonly string[], writerIds: string[], selection?: CommitRequest["selection"]) {
  return freezeChangeSelection(graph.review, graph, request(graph, componentIds, writerIds, selection));
}

describe("change components", () => {
  it("splits a file by hunk, preserves unselected bytes and pins immutable settlement anchors", () => {
    const git = gitEntry("example", before, after);
    const graph = buildChangeComponents(input([git], [splitEvidence]));
    const [groupA, groupB] = graph.view.groups;
    const idA = groupA!.own[0]!;
    const idB = groupB!.own[0]!;
    expect(graph.view.changedFiles).toBe(1);
    expect(graph.view.components).toHaveLength(2);
    expect(groupA).toMatchObject({ writer: writerA, tied: [] });
    expect(groupB).toMatchObject({ writer: writerB, tied: [] });
    expect(getComponentDiff(graph, idA, "example")).toMatchObject({
      generation: 1, component: idA, path: "example",
      hunks: [{ kind: "content", before: "base A\n", after: "new A\n", writers: [writerA], other: false }],
    });
    expect(getComponentDiff(graph, idA, "wrong path")).toBeNull();

    const frozen = select(graph, [idA], [a], { kind: "writer", writerId: a })!;
    expect(frozen.entries).toEqual([{ path: "example", mode: "100644", kind: "partial", content: Buffer.from("new A\nseparator\nbase B") }]);
    expect(frozen.components).toEqual([{ id: idA, writerIds: [a], paths: ["example"], other: false, incomplete: false }]);
    const receipt = frozen.ownership;
    expect(JSON.parse(JSON.stringify(receipt))).toMatchObject({
      version: 1, head: baseHead, generation: 1, componentIds: [idA],
      paths: [{
        path: "example", base: { oid: blob(before.bytes), mode: "100644", sha256: hash(before.bytes), rawSha256: hash(before.bytes) },
        working: { mode: "100644", sha256: hash(after.bytes) }, frozen: { mode: "100644", sha256: hash(frozen.entries[0]!.content!) },
        hunks: [{
          componentId: idA, kind: "content", range: { oldStart: 0, oldCount: 1, newStart: 0, newCount: 1 },
          executionIds: ["a"], ties: [], beforeSha256: hash("base A\n"), afterSha256: hash("new A\n"),
        }],
      }],
    });
    expect(Object.isFrozen(receipt.paths[0]!.hunks[0]!.executionIds)).toBe(true);
    frozen.entries[0]!.content!.fill(0);
    expect(select(graph, [idA, idB], [a, b])!.entries[0]!.content).toEqual(after.bytes);
  });

  it("keeps a same-hunk tie local and gates every mixed Other component on its own explicit tick", () => {
    const base = file("line 0\nseparator\nline 2\nseparator\nline 4\n");
    const current = file("updated 0\nseparator\nupdated 2\nseparator\nupdated 4\n");
    const path = "multi";
    const graph = buildChangeComponents(input([gitEntry(path, base, current)], [
      evidence(path, base, current, [changed(0, ["a"]), changed(2, ["a", "b", null]), changed(4, ["b"])]),
    ]));
    const [groupA, groupB] = graph.view.groups;
    const own = groupA!.own[0]!;
    const tied = groupA!.tied[0]!;
    expect(groupB!.tied).toEqual([tied]);
    expect(groupB!.own).toHaveLength(1);
    expect(graph.view.components.find(({ id }) => id === tied)).toMatchObject({ writers: [writerA, writerB], other: true });
    expect(select(graph, [own], [a], { kind: "delete", writerId: a })!.entries[0]!.content!.toString()).toContain("updated 0\n");
    expect(select(graph, [tied], [a, b])).toBeNull();
    expect(select(graph, [tied], [a, b], { kind: "explicit", otherComponentIds: [tied] })!.entries[0]!.content!.toString())
      .toBe("line 0\nseparator\nupdated 2\nseparator\nline 4\n");
    expect(select(graph, [own, tied], [a, b], { kind: "writer", writerId: a })).toBeNull();
    expect(select(graph, [own], [a], { kind: "explicit", otherComponentIds: [own] })).toBeNull();
  });

  it("applies explicit rewriting ties across hunks and refuses a move missing one endpoint", () => {
    const move = "move evidence";
    const from = evidence("from", before, null, [
      hunk({ oldStart: 0, oldCount: 3, newStart: 0, newCount: 0 }, ["a"]), metadata("presence", ["a"]),
    ], [move]);
    const to = evidence("to", null, after, [
      hunk({ oldStart: 0, oldCount: 0, newStart: 0, newCount: 3 }, ["a", "b"]), metadata("presence", ["a"]),
    ], [move]);
    const source = gitEntry("from", before, null);
    const destination = gitEntry("to", null, after);
    const graph = buildChangeComponents(input([destination, source], [from, to]));
    const [component] = graph.view.components;
    expect(component).toMatchObject({
      files: [{ path: "from", entry: "move" }, { path: "to", entry: "move" }], selectable: true,
    });
    expect(select(graph, [component!.id], [a, b])!.entries).toEqual([
      { path: "from", kind: "whole", mode: "0", content: null },
      { path: "to", kind: "whole", mode: "100644", content: after.bytes },
    ]);
    const half = buildChangeComponents(input([destination], [to]));
    expect(half.view.components[0]).toMatchObject({ selectable: false, reason: "Both endpoints of this move must be available" });
    expect(select(half, [half.view.components[0]!.id], [a, b])).toBeNull();

    const rewritten = buildChangeComponents(input([gitEntry("example", before, after)], [
      evidence("example", before, after, [changed(0, ["a"], ["rewrite"]), changed(2, ["b"], ["rewrite"])]),
    ]));
    expect(rewritten.view.components).toHaveLength(1);
    expect(rewritten.view.groups.map(({ own, tied }) => [own.length, tied.length])).toEqual([[0, 1], [0, 1]]);
  });

  it("projects registry state across executions and refuses automatic deletion of incomplete work", () => {
    const path = "example";
    const another = "other";
    const records = [record("a"), record("a2", writerA, { outcome: "stopped", nativeSessionId: "saved-A" }), record("b", writerB)];
    const files = [evidence(path, before, after, [changed(0, ["a"]), changed(2, ["a2", "b"])]),
      evidence(another, one, two, [changed(0, ["b"])])];
    const entries = [gitEntry(path, before, after), gitEntry(another, one, two)];
    const setup = input(entries, files, { writers: { projectId: "project", executions: records } });
    const graph = buildChangeComponents(setup);
    const [groupA, groupB] = graph.view.groups;
    expect(groupA).toMatchObject({ incomplete: true, state: "open" });
    expect(groupB!.incomplete).toBeUndefined();
    expect(select(graph, groupA!.own, [a], { kind: "delete", writerId: a })).toBeNull();
    expect(select(graph, groupA!.tied, [a, b])!.components[0]!.incomplete).toBe(true);
    const unproved = buildChangeComponents({
      ...setup, writers: { projectId: "project", executions: [...records, record("a3", writerA, { continuesExecutionId: "a2" })] },
    });
    expect(unproved.view.groups[0]!.incomplete).toBe(true);
    const continued = buildChangeComponents({
      ...setup,
      writers: { projectId: "project", executions: [...records, record("a3", writerA, { continuesExecutionId: "a2", nativeSessionId: "saved-A" })] },
      closedGroups: [{ writer: writerA, title: "Deleted A" }],
    });
    expect(continued.view.groups[0]!.state).toBe("closed");
    expect(select(continued, continued.view.groups[0]!.own, [a], { kind: "delete", writerId: a })).toBeTruthy();
    const pending = buildChangeComponents({ ...setup, writers: {
      projectId: "project", executions: [...records, record("b-followup", writerB, { pending: true })],
    } });
    expect(pending.view.groups.find(({ writer }) => writer.id === "b")).toMatchObject({ state: "working", reason: "A writer is still working" });
    expect(pending.view.components.filter(({ writers }) => writers.some(({ id }) => id === "b")).every(({ selectable }) => !selectable)).toBe(true);
    expect(pending.view.components.find(({ id }) => id === groupA!.own[0])!.selectable).toBe(true);

    for (const [phase, outcome, state, reason] of [
      ["queued", undefined, "working", "A writer is still working"],
      ["running", undefined, "working", "A writer is still working"],
      ["settling", "completed", "working", "A writer is still working"],
      ["settling", "stopped", "stopping", "A writer is still stopping"],
      ["unconfirmed", "stopped", "stopping", "Vizzo couldn't confirm a writer stopped"],
    ] as const) {
      const active = buildChangeComponents({ ...setup, writers: {
        projectId: "project", executions: [...records, record("new", writerA, { phase, outcome })],
      } });
      expect(active.view.groups[0]).toMatchObject({ state, reason });
      expect(select(active, active.view.groups[0]!.own, [a])).toBeNull();
    }
  });

  it("uses the exact registered writer kind and changes a component ID on handoff", () => {
    const entries = [gitEntry("example", one, two)];
    const files = [evidence("example", one, two, [changed(0, ["a"])])];
    const central = buildChangeComponents(input(entries, files, { writers: { projectId: "project", executions: [record("a", centralA)] } }));
    const job = buildChangeComponents(input(entries, files, { writers: { projectId: "project", executions: [record("a", jobA)] } }));
    expect(central.view.groups[0]!.writer).toEqual(centralA);
    expect(job.view.groups[0]!.writer).toEqual(jobA);
    expect(central.view.components[0]!.id).not.toBe(job.view.components[0]!.id);
  });

  it("requires complete exact range coverage and checks the independent entry fingerprints", () => {
    const git = gitEntry("example", before, after);
    const match = buildChangeComponents(input([git], [splitEvidence]));
    const wrongRanges = { ...splitEvidence, hunks: [changed(0, ["a"])] };
    const wrongMode = { ...splitEvidence, current: ledgerEntry(file(after.bytes, "100755")) };
    const wrongPresence = { ...splitEvidence, current: ledgerEntry(null) };
    const wrongType = { ...splitEvidence, current: ledgerEntry(file(after.bytes, "120000")) };
    const wrongBytes = { ...splitEvidence, current: ledgerEntry(file("different\n")) };
    for (const bad of [wrongRanges, wrongMode, wrongPresence, wrongType, wrongBytes]) {
      const graph = buildChangeComponents(input([git], [bad]));
      expect(graph.view.groups).toEqual([]);
      const [component] = graph.view.components;
      expect(component).toMatchObject({ other: true, selectable: true });
      expect(getComponentDiff(graph, component!.id, "example")!.hunks[0]!.reason).toMatch(/different versions/);
      expect(select(graph, [component!.id], [])).toBeNull();
      expect(select(graph, [component!.id], [], { kind: "explicit", otherComponentIds: [component!.id] })!.entries[0]!.content).toEqual(after.bytes);
      expect(freezeChangeSelection(match.review, graph, request(match, match.view.groups[0]!.own, [a]))).toBeNull();
    }
    for (const bad of [
      { ...git, current: { ...git.current!, sha256: hash("different") } },
      { ...git, base: { ...git.base!, workingSha256: hash("different") } },
      { ...git, base: { ...git.base!, raw: Buffer.from("different") } },
    ]) {
      const mismatched = buildChangeComponents(input([bad], [splitEvidence]));
      expect(mismatched.view.components[0]).toMatchObject({ other: true, selectable: false, reason: "Git entry fingerprint could not be verified" });
    }
    const noProof = buildChangeComponents(input([git], [splitEvidence], {
      ledger: { head: baseHead, headMoved: false, files: [splitEvidence], snapshots: [] },
    }));
    expect(noProof.view.groups).toEqual([]);
    const noWriter = buildChangeComponents(input([git], [splitEvidence], { writers: { projectId: "project", executions: [record("b", writerB)] } }));
    expect(noWriter.view.components.find(({ other }) => other)).toMatchObject({
      selectable: false, reason: "A writer's execution could not be verified",
    });
  });

  it("accepts equivalent review across generations and rejects stale IDs, counts, scope, and HEAD", () => {
    const e = gitEntry("example", before, after);
    const initial = input([e], [splitEvidence]);
    const reviewed = buildChangeComponents(initial);
    const id = reviewed.view.groups[0]!.own[0]!;
    const selection = request(reviewed, [id], [a]);
    const unrelated = gitEntry("unrelated", one, two);
    const fresh = buildChangeComponents({ ...initial, generation: 2, git: { entries: [unrelated, e] } });
    expect(fresh.view.changedFiles).toBe(2);
    expect(freezeChangeSelection(reviewed.review, fresh, selection)?.generation).toBe(1);
    for (const override of [
      { generation: 2 }, { projectId: "another" }, { componentIds: [id, id] }, { componentIds: ["missing"] },
      { writerIds: [a, a] }, { writerIds: [a, b] }, { componentIds: [] },
    ]) expect(freezeChangeSelection(reviewed.review, fresh, { ...selection, ...override })).toBeNull();

    const updated = file("A newer A\nseparator\nnew B");
    const fileChange = buildChangeComponents(input([gitEntry("example", before, updated)], [
      evidence("example", before, updated, [changed(0, ["a"]), changed(2, ["b"])]),
    ]));
    const scopeChange = buildChangeComponents({ ...initial, scope: { worktreeRoot: "/repo", projectDir: "/repo/subproject" } });
    const headChange = buildChangeComponents({ ...initial, head: alternateHead });
    const branchChange = buildChangeComponents({ ...initial, head: { ...baseHead, branch: "refs/heads/other" } });
    const detached = buildChangeComponents({ ...initial, head: { ...baseHead, branch: null } });
    expect(detached.view.components[0]).toMatchObject({ selectable: false, reason: "HEAD is detached" });
    const tieChange = buildChangeComponents(input([e], [
      evidence("example", before, after, [changed(0, ["a", null]), changed(2, ["b"])]),
    ]));
    for (const changed of [fileChange, scopeChange, headChange, branchChange, detached, tieChange]) {
      expect(freezeChangeSelection(reviewed.review, changed, selection)).toBeNull();
    }
  });

  it("revalidates unchanged partial bytes after another writer shifts the worktree offsets", () => {
    const path = "example";
    const original = [changed(0, ["b"]), changed(2, ["a"])];
    const writers = { projectId: "project", executions: [record("a"), record("b", writerB, { phase: "running" })] };
    const baseline = buildChangeComponents(input([gitEntry(path, before, after)], [
      evidence(path, before, after, original),
    ], { writers }));
    const id = baseline.view.groups.find(({ writer }) => writer.id === "a")!.own[0]!;
    const selected = request(baseline, [id], [a]);
    const movedB = hunk({ oldStart: 0, oldCount: 1, newStart: 0, newCount: 2 }, ["b"]);
    const rangeA = { oldStart: 2, oldCount: 1, newStart: 3, newCount: 1 };
    const moreB = file("new B edit\nnew B line\nseparator\nnew B", "100755");
    const make = (current: Entry, owners: (string | null)[], ties: string[] = []) =>
      buildChangeComponents(input([gitEntry(path, before, current)], [
        evidence(path, before, current, [movedB, hunk(rangeA, owners, ties), metadata("mode", [null])]),
      ], { generation: 2, writers }));

    const fresh = make(moreB, ["a"]);
    expect(fresh.view.groups.find(({ writer }) => writer.id === "a")!.own).toEqual([id]);
    const frozen = freezeChangeSelection(baseline.review, fresh, selected)!;
    expect(frozen.entries[0]).toEqual({
      path, kind: "partial", mode: "100644", content: Buffer.from("base A\nseparator\nnew B"),
    });
    expect(frozen.ownership.paths[0]).toMatchObject({
      working: { mode: "100755", sha256: hash(moreB.bytes) }, hunks: [{ range: rangeA }],
    });
    const changedA = make(file("new B edit\nnew B line\nseparator\nnew A bytes", "100755"), ["a"]);
    const newTie = make(moreB, ["a", "b"], ["rewrite"]);
    expect(freezeChangeSelection(baseline.review, changedA, selected)).toBeNull();
    expect(freezeChangeSelection(baseline.review, newTie, selected)).toBeNull();
  });

  it("keeps separate chmod, empty presence and a user's creation dependency", () => {
    const executable = file(after.bytes, "100755");
    const empty = file("");
    const ownEmptyExec = file("", "100755");
    const source = input(
      [gitEntry("example", before, executable), gitEntry("empty", null, ownEmptyExec), gitEntry("existing", empty, null), gitEntry("user", null, two)],
      [
        evidence("example", before, executable, [...splitEvidence.hunks, metadata("mode", [null])]),
        evidence("empty", null, ownEmptyExec, [metadata("presence", ["a"]), metadata("mode", [null])]),
        evidence("existing", empty, null, [metadata("presence", ["a"])]),
        evidence("user", null, two, [hunk({ oldStart: 0, oldCount: 0, newStart: 0, newCount: 1 }, ["a"]), metadata("presence", [null])]),
      ],
    );
    const graph = buildChangeComponents(source);
    const own = graph.view.groups[0]!.own;
    const frozen = select(graph, own, [a], { kind: "delete", writerId: a })!;
    expect(frozen.entries).toEqual([
      { path: "empty", kind: "whole", mode: "100644", content: Buffer.alloc(0) },
      { path: "example", kind: "partial", mode: "100644", content: Buffer.from("new A\nseparator\nbase B") },
      { path: "existing", kind: "whole", mode: "0", content: null },
    ]);
    expect(select(graph, own.slice(0, 1), [a], { kind: "delete", writerId: a })).toBeNull();
    const mode = graph.view.components.find(({ files }) => files[0]?.path === "empty" && files[0].entry === "mode")!;
    const create = mode.requires![0]!;
    expect(select(graph, [mode.id], [], { kind: "explicit", otherComponentIds: [mode.id] })).toBeNull();
    expect(select(graph, [mode.id, create], [a], { kind: "explicit", otherComponentIds: [mode.id] })?.entries[0]?.mode).toBe("100755");
    const mixed = graph.view.components.find(({ files }) => files[0]?.path === "user")!;
    expect(mixed).toMatchObject({ other: true, writers: [writerA], files: [{ entry: "presence" }] });
  });

  it("ties a file/directory replacement and a type change to their content", () => {
    const path = "node";
    const child = "node/child";
    const symbolic = file("target", "120000");
    const graph = buildChangeComponents(input([
      gitEntry(path, one, null), gitEntry(child, null, two),
      gitEntry("link", symbolic, two, { wholeEntryReason: "symlink", conversion: "whole" }),
    ], [
      evidence(path, one, null, [hunk({ oldStart: 0, oldCount: 1, newStart: 0, newCount: 0 }, [null]), metadata("presence", [null])]),
      evidence(child, null, two, [hunk({ oldStart: 0, oldCount: 0, newStart: 0, newCount: 1 }, ["a"]), metadata("presence", ["a"])]),
      evidence("link", symbolic, two, [changed(0, ["b"]), metadata("type", [null])]),
    ]));
    const [link, replacement] = graph.view.components;
    expect(replacement).toMatchObject({ other: true, writers: [writerA], files: [{ path }, { path: child }] });
    expect(link).toMatchObject({ other: true, writers: [writerB], files: [{ path: "link", entry: "symlink" }] });
    expect(select(graph, [replacement!.id], [a])).toBeNull();
    expect(select(graph, [replacement!.id], [a], { kind: "explicit", otherComponentIds: [replacement!.id] })!.entries)
      .toMatchObject([{ path, mode: "0" }, { path: child, mode: "100644" }]);
  });
});

const dirs: string[] = [];
beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repo(format: "files" | "reftable", objectFormat = "sha1") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vizzo-components-")));
  dirs.push(root);
  const git = (...args: string[]): string => execFileSync("git", ["-C", root, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
  git("init", "-q", "--template=", "--initial-branch=main", "--ref-format=" + format, "--object-format=" + objectFormat);
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Components Test");
  git("config", "core.autocrlf", "false");
  git("config", "core.filemode", "true");
  const path = (name: string) => join(root, name);
  const put = (name: string, content: string | Buffer) => writeFile(path(name), content);
  const indexPath = path(".git/index");
  const scope = { worktreeRoot: root, projectDir: root };
  const head = (): GitScanHead => ({ branch: git("symbolic-ref", "HEAD"), oid: git("rev-parse", "HEAD") });
  const commit = (): GitScanHead => {
    git("add", "-A");
    git("commit", "-qm", "Fixture commit");
    return head();
  };
  const scan = (selectedHead: GitScanHead) => scanGitChanges(scope, selectedHead);
  const build = async (
    selectedHead: GitScanHead, files: LedgerFile[], options: Partial<ChangeComponentInput> = {},
  ) => buildChangeComponents(input((await scan(selectedHead)).entries, files, {
    scope, head: selectedHead, ledger: { head: selectedHead, headMoved: false, files, snapshots: files }, ...options,
  }));
  return { root, git, path, put, indexPath, scope, head, commit, scan, build };
}

describe.each(["files", "reftable"] as const)("component Git fixtures (%s refs)", (format) => {
  it("freezes one of two edits in the same file from an exact independent read", async () => {
    const fixture = await repo(format, format === "reftable" ? "sha256" : "sha1");
    await fixture.put("example", before.bytes);
    const selectedHead = fixture.commit();
    await fixture.put("example", after.bytes);
    await chmod(fixture.path("example"), 0o755);
    const baseIndex = await readFile(fixture.indexPath);
    const final = file(after.bytes, "100755");
    const graph = await fixture.build(selectedHead, [
      evidence("example", before, final, [...splitEvidence.hunks, metadata("mode", [null])]),
    ]);
    const id = graph.view.groups[0]!.own[0]!;
    const frozen = select(graph, [id], [a])!;
    const built = await buildCommitTree({
      root: fixture.root, indexPath: fixture.indexPath, base: selectedHead.oid, entries: frozen.entries, message: "Selected edit",
    });
    expect(fixture.git("show", built.commit + ":example")).toBe("new A\nseparator\nbase B");
    expect(fixture.git("ls-tree", built.commit, "example")).toMatch(/^100644 /);
    expect(await readFile(fixture.path("example"))).toEqual(after.bytes);
    expect(await readFile(fixture.indexPath)).toEqual(baseIndex);
    expect(fixture.head()).toEqual(selectedHead);
  });

  it("keeps the repository read-only after external HEAD moves and discards pre-move claims", async () => {
    const fixture = await repo(format);
    await fixture.put("example", before.bytes);
    const selectedHead = fixture.commit();
    const committedByTerminal = file("new A\nseparator\nbase B");
    await fixture.put("example", after.bytes);
    const reviewed = await fixture.build(selectedHead, [splitEvidence]);
    const reviewA = request(reviewed, reviewed.view.groups[0]!.own, [a]);
    await fixture.put("example", committedByTerminal.bytes);
    fixture.git("add", "--", "example");
    await fixture.put("example", after.bytes);
    fixture.git("commit", "-qm", "Terminal commit");
    const moved = fixture.head();
    const currentRef = fixture.git("show-ref");
    const index = await readFile(fixture.indexPath);
    const objects = fixture.git("count-objects", "-v");
    const status = fixture.git("status", "--porcelain=v2");
    const stale = await fixture.build(moved, [], { generation: 2, ledger: {
      head: selectedHead, headMoved: false, files: [splitEvidence], snapshots: [splitEvidence],
    } });
    expect(stale.view.groups).toEqual([]);
    expect(stale.view.components[0]).toMatchObject({ other: true });
    expect(stale.view.notices[0]).toMatch(/HEAD moved/);
    expect(freezeChangeSelection(reviewed.review, stale, reviewA)).toBeNull();

    const rejoined = await fixture.build(moved, [evidence("example", committedByTerminal, after, [changed(2, ["b"])])]);
    expect(rejoined.view.groups[0]!.writer).toEqual(writerB);
    expect(fixture.git("show-ref")).toBe(currentRef);
    expect(fixture.git("status", "--porcelain=v2")).toBe(status);
    expect(fixture.git("count-objects", "-v")).toBe(objects);
    expect(await readFile(fixture.indexPath)).toEqual(index);
    expect(await readFile(fixture.path("example"))).toEqual(after.bytes);

    fixture.git("branch", "other", moved.oid!);
    fixture.git("symbolic-ref", "HEAD", "refs/heads/other");
    const otherBranch = fixture.head();
    const switched = await fixture.build(otherBranch, [evidence("example", committedByTerminal, after, [changed(2, ["b"])])]);
    expect(otherBranch.oid).toBe(moved.oid);
    expect(switched.view.components[0]!.id).not.toBe(rejoined.view.components[0]!.id);
    fixture.git("update-ref", "refs/heads/other", selectedHead.oid!, moved.oid!);
    const returned = fixture.head();
    expect((await fixture.build(returned, [], { ledger: {
      head: moved, headMoved: false, files: [], snapshots: [],
    } })).view.groups).toEqual([]);
  });
});

describe("whole Git entries", () => {
  it("converts selected new and empty-base content under tree attributes while keeping chmod independent", async () => {
    const fixture = await repo("files");
    await fixture.put(".gitattributes", "*.txt text eol=crlf\n");
    await fixture.put("empty.txt", "");
    const head = fixture.commit();
    const paths = ["empty.txt", "new.txt"];
    const content = file("first\nlast", "100755");
    for (const path of paths) {
      await fixture.put(path, content.bytes);
      await chmod(fixture.path(path), 0o755);
    }
    const addition = hunk({ oldStart: 0, oldCount: 0, newStart: 0, newCount: 2 }, ["a"]);
    const graph = await fixture.build(head, [
      evidence("empty.txt", file(""), content, [addition, metadata("mode", [null])]),
      evidence("new.txt", null, content, [addition, metadata("presence", ["a"]), metadata("mode", [null])]),
    ]);
    const own = graph.view.groups[0]!.own;
    const modes = graph.view.components.filter(({ files }) => files[0]?.entry === "mode");
    expect(own).toHaveLength(2);
    expect(modes.map(({ other }) => other)).toEqual([true, true]);
    const frozen = select(graph, own, [a])!;
    expect(frozen.entries).toEqual(paths.map((path) => ({ path, mode: "100644", kind: "whole", content: content.bytes })));

    const built = await buildCommitTree({
      root: fixture.root, indexPath: fixture.indexPath, base: head.oid, entries: frozen.entries, message: "Selected content",
    });
    for (const path of paths) {
      expect(fixture.git("show", built.commit + ":" + path)).toBe("first\nlast");
      expect(fixture.git("--attr-source=" + built.tree, "cat-file", "--filters", built.commit + ":" + path)).toBe("first\r\nlast");
      expect(await readFile(fixture.path(path))).toEqual(content.bytes);
    }
    const modeOnly = modes.find(({ files }) => files[0]?.path === "empty.txt")!.id;
    expect(select(graph, [modeOnly], [], { kind: "explicit", otherComponentIds: [modeOnly] })?.entries).toEqual([
      { path: "empty.txt", mode: "100755", kind: "partial", content: Buffer.alloc(0) },
    ]);
  });

  it("makes CRLF edits one component and blocks all of it when one owner is still working", async () => {
    const fixture = await repo("files");
    const base = file("base A\r\nseparator\r\nbase B\r\n");
    const current = file("new A\r\nseparator\r\nnew B\r\n");
    await fixture.put("example", base.bytes);
    const head = fixture.commit();
    await fixture.put("example", current.bytes);
    const files = [evidence("example", base, current, splitEvidence.hunks)];
    const working = await fixture.build(head, files, { writers: {
      projectId: "project", executions: [record("a"), record("b", writerB, { phase: "running" })],
    } });
    const [component] = working.view.components;
    expect(working.view.components).toHaveLength(1);
    expect(component).toMatchObject({ selectable: false, reason: "A writer is still working", writers: [writerA, writerB] });
    expect(select(working, [component!.id], [a, b])).toBeNull();
    const settled = await fixture.build(head, files);
    const id = settled.view.components[0]!.id;
    expect(select(settled, [id], [a, b])!.entries).toEqual([
      { path: "example", mode: "100644", kind: "whole", content: current.bytes },
    ]);
  });

  it("keeps identity safety when attributes or CRLF change at freeze and uses the base attributes of unselected entries", async () => {
    const fixture = await repo("files");
    await fixture.put("example", before.bytes);
    await fixture.put("filtered", before.bytes);
    await fixture.put(".gitattributes", "filtered filter=example\n");
    const head = fixture.commit();
    await fixture.put("example", after.bytes);
    const first = await fixture.build(head, [splitEvidence]);
    const selection = request(first, first.view.groups[0]!.own, [a]);
    const crlf = file(after.bytes.toString().replaceAll("\n", "\r\n"));
    await fixture.put("example", crlf.bytes);
    const withCr = await fixture.build(head, [evidence("example", before, crlf, [
      hunk({ oldStart: 0, newStart: 0, oldCount: 3, newCount: 3 }, ["a", "b"]),
    ])]);
    expect(freezeChangeSelection(first.review, withCr, selection)).toBeNull();
    await fixture.put("example", after.bytes);

    const attrsBase = file("filtered filter=example\n");
    const attrsCurrent = file("example ident\n");
    await fixture.put(".gitattributes", attrsCurrent.bytes);
    await fixture.put("filtered", after.bytes);
    const attributes = await fixture.build(head, [
      splitEvidence, evidence("filtered", before, after, splitEvidence.hunks),
      evidence(".gitattributes", attrsBase, attrsCurrent, [changed(0, ["a"])]),
    ]);
    expect(freezeChangeSelection(first.review, attributes, selection)).toBeNull();
    for (const path of ["example", "filtered"]) {
      const component = attributes.view.components.find(({ files }) => files[0]?.path === path)!;
      expect(component.writers).toEqual([writerA, writerB]);
      expect(select(attributes, [component.id], [a, b])!.entries[0]?.kind).toBe("whole");
    }
    const attributesComponent = attributes.view.components.find(({ files }) => files[0]?.path === ".gitattributes")!;
    expect(select(attributes, [attributesComponent.id], [a])!.entries[0]?.kind).toBe("whole");
  });

  it("freezes symlink text and binary bytes whole, and leaves oversized and staged paths unavailable", async () => {
    const fixture = await repo("files");
    const binaryBefore = file(Buffer.from([0, 10, 1, 10, 2]));
    const binaryAfter = file(Buffer.from([3, 0, 10, 1, 10, 4]));
    const linkBefore = file("old-target", "120000");
    const linkAfter = file("new-target", "120000");
    await fixture.put("binary", binaryBefore.bytes);
    await fixture.put("staged", one.bytes);
    await symlink(linkBefore.bytes, fixture.path("link"));
    const head = fixture.commit();
    await fixture.put("binary", binaryAfter.bytes);
    await unlink(fixture.path("link"));
    await symlink(linkAfter.bytes, fixture.path("link"));
    await fixture.put("staged", two.bytes);
    fixture.git("add", "--", "staged");
    await fixture.put("large", "");
    await truncate(fixture.path("large"), GIT_SCAN_MAX_FILE_BYTES + 1);
    const graph = await fixture.build(head, [
      evidence("binary", binaryBefore, binaryAfter, splitEvidence.hunks),
      evidence("link", linkBefore, linkAfter, [changed(0, [null])]),
    ]);
    const named = (path: string) => graph.view.components.find(({ files }) => files[0]?.path === path)!;
    const binary = named("binary");
    const link = named("link");
    expect(graph.view.changedFiles).toBe(4);
    expect(binary).toMatchObject({ files: [{ entry: "binary", added: 0, removed: 0 }], writers: [writerA, writerB] });
    expect(getComponentDiff(graph, binary.id, "binary")!.hunks[0]?.before).toBeUndefined();
    expect(select(graph, [binary.id], [a, b])!.entries[0]).toMatchObject({ kind: "whole", content: binaryAfter.bytes });
    expect(named("large")).toMatchObject({ other: true, selectable: false, reason: "Too large for Vizzo to track" });
    expect(named("staged")).toMatchObject({ other: true, selectable: false, reason: "This path has staged changes" });
    expect(select(graph, [link.id], [], { kind: "explicit", otherComponentIds: [link.id] })!.entries[0]).toEqual({
      path: "link", mode: "120000", kind: "whole", content: linkAfter.bytes,
    });
  });

  it("joins a staged Git rename even without ledger ownership", async () => {
    const fixture = await repo("files");
    await fixture.put("old", "old text\n");
    const head = fixture.commit();
    await rename(fixture.path("old"), fixture.path("new"));
    fixture.git("add", "-A");
    const graph = await fixture.build(head, []);
    expect(graph.view.components).toHaveLength(1);
    expect(graph.view.components[0]).toMatchObject({
      selectable: false, other: true, files: [{ path: "new", entry: "move" }, { path: "old", entry: "move" }],
    });
  });
});
