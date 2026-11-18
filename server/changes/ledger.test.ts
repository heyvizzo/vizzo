import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyExactPatch, MAX_FILE_BYTES, parsePatch, PENDING_MS, TOO_LARGE, type EditChange } from "./evidence.ts";
import { lineDiff } from "./lineDiff.ts";
import { LedgerStore, type LedgerFile } from "./ledger.ts";
import { LedgerWorkerClient } from "./ledgerWorkerClient.ts";
import { LedgerPersistence } from "./persistence.ts";
import { discoverLedgerProject, readBaseEntry, readLedgerHead, readWorkingEntry, type LedgerProject } from "./project.ts";

let folder: string;
let root: string;
let journal: string;
let project: LedgerProject;
let store: LedgerStore;
let seq: number;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function put(path: string, bytes: string | Buffer): void { writeFileSync(join(root, path), bytes); }
function commit(): void { git("add", "-A"); git("commit", "-qm", "base"); }

function discover(path = root): LedgerProject {
  const found = discoverLedgerProject(path);
  if (!found.project) throw new Error(found.reason);
  return found.project;
}

function event(id: string, ...changes: EditChange[]) {
  return { executionId: id, sessionId: "native-session", toolCallId: String(seq++), outcome: "completed" as const, changes };
}

function edit(id: string, from: string | null, to: string | null, path = "f") {
  return event(id, { path: join(root, path), from, to });
}

function file(path = "f"): LedgerFile {
  const inspected = store.observe(project, [path]).files[0];
  if (!inspected) throw new Error(`No changes in ${path}`);
  return inspected;
}

function owners(path = "f"): (string | null)[][] {
  return file(path).hunks.map(({ ownership }) => ownership.owners);
}

beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), "vizzo-ledger-test-")));
  root = join(folder, "worktree");
  journal = join(folder, "config", "ledger.json");
  mkdirSync(root);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Vizzo");
  git("config", "user.email", "vizzo@example.test");
  project = discover();
  store = new LedgerStore(new LedgerPersistence(journal));
  seq = 0;
});

afterEach(() => rmSync(folder, { recursive: true, force: true }));

describe("Git-backed project evidence", () => {
  it("distinguishes an existing non-repository from an unavailable directory", () => {
    expect(discoverLedgerProject(folder)).toEqual({ reason: "The project folder is not in a Git worktree" });
    expect(discoverLedgerProject(join(folder, "missing")).reason).toContain("ENOENT");
  });

  it("uses the true tree blob even when Git has a replacement ref", () => {
    put("f", "original\n");
    put("replacement", "replacement\n");
    commit();
    git("replace", git("rev-parse", "HEAD:f"), git("rev-parse", "HEAD:replacement"));
    expect(git("show", "HEAD:f")).toBe("replacement");
    expect(readBaseEntry(project, "f", readLedgerHead(project))).toEqual({
      kind: "file", mode: "100644", bytes: Buffer.from("original\n"),
    });
  });
});

describe("chain of custody", () => {
  it("attaches exact interleaved edits even when completions arrive out of order", () => {
    const base = "one\na\nb\nc\nthree\n";
    const a = "ONE\na\nb\nc\nthree\n";
    const b = "ONE\na\nb\nc\nTHREE\n";
    put("f", base);
    commit();
    put("f", b);
    expect(store.ingest(project, edit("B", a, b)).results).toEqual(["pending"]);
    expect(store.ingest(project, edit("A", base, a)).results).toEqual(["applied"]);
    expect(owners()).toEqual([["A"], ["B"]]);
    expect(store.pending().executionIds).toEqual([]);
  });

  it("splits a scanned gap into an exact prefix, an Other part and an exact suffix", () => {
    const base = "one\na\nb\nc\nthree\n";
    const a = "ONE\na\nb\nc\nthree\n";
    const user = "ONE\na\nB\nc\nthree\n";
    const b = "ONE\na\nB\nc\nTHREE\n";
    put("f", base);
    commit();
    put("f", user);
    expect(owners()).toEqual([[null], [null]]);
    put("f", b);
    expect(owners()).toEqual([[null], [null], [null]]);
    expect(store.ingest(project, edit("B", user, b)).results).toEqual(["applied"]);
    expect(store.ingest(project, edit("A", base, a)).results).toEqual(["applied"]);
    expect(owners()).toEqual([["A"], [null], ["B"]]);
  });

  it("reconnects an exact rollback only at an independently observed matching endpoint", () => {
    put("f", "base\n");
    commit();
    put("f", "A\n");
    store.ingest(project, edit("A", "base\n", "A\n"));
    expect(owners()).toEqual([["A"]]);
    put("f", "B\n");
    const b = edit("B", "base\n", "B\n");
    expect(store.ingest(project, b).results).toEqual(["pending"]);
    expect(owners()).toEqual([["B"]]);
    expect(store.ingest(project, b).results).toEqual(["applied"]);
    const rival = edit("C", "base\n", "B\n");
    expect(store.ingest(project, rival).results).toEqual(["pending"]);
    expect(owners()).toEqual([["B"]]);
  });

  it("does not infer a historical rollback from a numbered contextual patch", () => {
    put("f", "base\n");
    commit();
    put("f", "A\n");
    store.ingest(project, edit("A", "base\n", "A\n"));
    expect(owners()).toEqual([["A"]]);
    put("f", "B\n");
    const competing = event("B", { path: join(root, "f"), patch: "@@ -1 +1 @@\n-base\n+B\n" });
    expect(store.ingest(project, competing).results).toEqual(["pending"]);
    expect(owners()[0]).toContain(null);
    expect(owners()[0]).not.toContain("B");
    expect(store.ingest(project, competing).results).toEqual(["pending"]);
  });

  it("uses the observed bytes even if a pending event would predict a different tail", () => {
    put("f", "base\n");
    commit();
    expect(store.ingest(project, edit("A", "intermediate\n", "A\n")).results).toEqual(["pending"]);
    put("f", "intermediate\n");
    const result = file();
    expect(result.hunks[0]?.ownership.owners).toContain(null);
    expect(new LedgerPersistence(journal).content(project.id).get(
      (result.current as { blob: string }).blob,
    )).toEqual(Buffer.from("intermediate\n"));
    expect(store.pending().executionIds).toEqual([]);
  });

  it("expires exact no-matches and never replays the expired event", () => {
    put("f", "base\n");
    commit();
    const unmatched = edit("A", "not yet witnessed\n", "A\n");
    expect(store.ingest(project, unmatched, 100).results).toEqual(["pending"]);
    expect(store.pending(100 + PENDING_MS - 1)).toEqual({ executionIds: ["A"], deadline: 100 + PENDING_MS });
    expect(store.pending(100 + PENDING_MS).executionIds).toEqual([]);
    put("f", "not yet witnessed\n");
    expect(owners()).toEqual([[null]]);
    put("f", "A\n");
    expect(store.ingest(project, unmatched).results).toEqual(["expired"]);
    expect(owners()).toEqual([[null]]);
  });

  it("keeps a completed tool write and the user's subsequent change as a gap", () => {
    put("f", "base\nmiddle\nlast\n");
    commit();
    put("f", "A\nmiddle\nOTHER\n");
    store.ingest(project, edit("A", "base\nmiddle\nlast\n", "A\nmiddle\nlast\n"));
    expect(owners()).toEqual([["A"], [null]]);
  });

  it("applies replace-all hunks at exact offsets without normalizing CR or EOF", () => {
    put("f", "same\r\nKEEP\r\nsame");
    commit();
    const patch = "@@ -1 +1 @@\n-same\r\n+NEW\r\n@@ -3 +3 @@\n-same\n\\ No newline at end of file\n+NEW\n\\ No newline at end of file\n";
    put("f", "NEW\r\nKEEP\r\nNEW");
    const batch = event("A", { path: join(root, "f"), patch });
    expect(store.ingest(project, batch).results).toEqual(["applied"]);
    expect(owners()).toEqual([["A"], ["A"]]);
    expect(new LedgerPersistence(journal).content(project.id).get(
      (file().current as { blob: string }).blob,
    )).toEqual(Buffer.from("NEW\r\nKEEP\r\nNEW"));
    const hunks = parsePatch(join(root, "f"), patch)!;
    expect(applyExactPatch(Buffer.from("different\r\nsame\r\nsame"), hunks, false)).toBeUndefined();
    expect(applyExactPatch(Buffer.from("same\r\nKEEP\r\nsame\n"), hunks, false)).toBeUndefined();
  });

  it("reads Git hunk boundaries using LF even when changed bytes contain a header after CR", () => {
    expect(lineDiff(Buffer.from("prefix\r@@ -99 +99 @@\n"), Buffer.from("replacement\n"))).toEqual([
      { oldStart: 0, oldCount: 1, newStart: 0, newCount: 1 },
    ]);
  });

  it("preserves a numbered patch's exact duplicate insertion when another patch rewrites it", () => {
    const base = "start\nsame\nend\n";
    const inserted = "start\nsame\nsame\nend\n";
    const path = join(root, "f");
    put("f", base);
    commit();
    put("f", inserted);
    const a = event("A", { path, patch: "@@ -1,3 +1,4 @@\n start\n+same\n same\n end\n" });
    expect(store.ingest(project, a).results).toEqual(["applied"]);
    expect(file().hunks[0]).toMatchObject({ range: { newStart: 1 }, ownership: { owners: ["A"] } });
    put("f", "start\nB\nsame\nend\n");
    const b = event("B", { path, patch: "@@ -1,4 +1,4 @@\n start\n-same\n+B\n same\n end\n" });
    expect(store.ingest(project, b).results).toEqual(["applied"]);
    expect(owners()).toEqual([["A", "B"]]);
  });

  it("leaves a full-content duplicate insertion ambiguous when another writer edits one copy", () => {
    const base = "start\nsame\nend\n";
    const inserted = "start\nsame\nsame\nend\n";
    put("f", base);
    commit();
    put("f", inserted);
    expect(store.ingest(project, edit("A", base, inserted)).results).toEqual(["applied"]);
    expect(owners()).toEqual([[null]]);
    put("f", "start\nB\nsame\nend\n");
    const b = event("B", { path: join(root, "f"), patch: "@@ -1,4 +1,4 @@\n start\n-same\n+B\n same\n end\n" });
    expect(store.ingest(project, b).results).toEqual(["applied"]);
    expect(owners()).toEqual([[null, "B"]]);
  });

  it("projects the exact original-line tombstone for a numbered duplicate deletion", () => {
    put("f", "start\nsame\nsame\nend\n");
    commit();
    put("f", "start\nsame\nend\n");
    const a = event("A", { path: join(root, "f"), patch: "@@ -1,4 +1,3 @@\n start\n-same\n same\n end\n" });
    expect(store.ingest(project, a).results).toEqual(["applied"]);
    expect(file().hunks[0]).toMatchObject({ range: { oldStart: 1, oldCount: 1 }, ownership: { owners: ["A"] } });
  });

  it("does not choose the newest of two patch preimages when their identical removed lines have different origins", () => {
    put("f", "a\nold\nb\nc\nd\nold\ne\n");
    commit();
    put("f", "r\nold\ne\n");
    file();
    put("f", "a\nold\nb\nc\nd\ne\n");
    const a = event("A", { path: join(root, "f"), patch: "@@ -2 +1,0 @@\n-old\n" });
    expect(store.ingest(project, a)).toMatchObject({ results: ["rejected"], reason: "Patch matches more than one recorded preimage" });
    expect(owners().every((labels) => !labels.includes("A"))).toBe(true);
    store.compact(project, ["f"]);
    expect(store.ingest(project, a)).toMatchObject({ duplicate: true, results: ["rejected"] });
  });

  it("does not choose between recorded patch preimages with identical numbered context", () => {
    put("f", "start\nsame\nend\nfirst\n");
    commit();
    put("f", "start\nsame\nend\nsecond\n");
    file();
    put("f", "start\nB\nend\nsecond\n");
    const a = event("A", { path: join(root, "f"), patch: "@@ -1,3 +1,3 @@\n start\n-same\n+B\n end\n" });
    expect(store.ingest(project, a).results).toEqual(["rejected"]);
    expect(owners().every((labels) => !labels.includes("A"))).toBe(true);
  });

  it("requires before bytes in every bare patch hunk and complete consumption for deletion", () => {
    put("f", "one\ntwo\n");
    commit();
    const path = join(root, "f");
    expect(store.ingest(project, event("A", { path, patch: "@@ -1,0 +2 @@\n+maybe\n" })).results).toEqual(["rejected"]);
    expect(store.ingest(project, event("B", { path, patch: "@@ -1 +0,0 @@\n-one\n", to: null })).results).toEqual(["pending"]);
    unlinkSync(path);
    expect(owners()).toEqual([[null], [null]]);
    expect(store.ingest(project, event("C", { path, patch: "@@ -1,2 +0,0 @@\n-one\n-two\n", to: null })).results).toEqual(["applied"]);
    expect(owners()).toEqual([["C"], ["C"]]);
  });

  it("carries identical retypes through an uninterrupted Other gap", () => {
    const base = "one\nmiddle\nlast\n";
    const a = "ONE\nmiddle\nlast\n";
    put("f", base);
    commit();
    put("f", a);
    store.ingest(project, edit("A", base, a));
    put("f", "middle\nlast\n");
    expect(owners()).toEqual([[null, "A"]]);
    put("f", "ONE\nmiddle\nLAST\n");
    expect(owners()).toEqual([["A"], [null]]);
  });

  it("ties rewrites through a surviving tombstone and leaves another hunk independent", () => {
    const base = "one\na\nb\nc\nthree\n";
    const a = "ONE\na\nb\nc\nTHREE\n";
    const b = "a\nb\nc\nTHREE\n";
    put("f", base);
    commit();
    put("f", a);
    store.ingest(project, edit("A", base, a));
    put("f", b);
    store.ingest(project, edit("B", a, b));
    const [tied, independent] = file().hunks;
    expect(tied!.ownership.owners).toEqual(["A", "B"]);
    expect(independent!.ownership.owners).toEqual(["A"]);
    expect(tied!.ownership.ties).not.toContain(independent!.ownership.ties[0]);
  });

  it("ties content to Other's entry creation, and records an owned empty add", () => {
    put("f", "");
    expect(file().hunks.map((hunk) => hunk.kind)).toEqual(["presence"]);
    put("f", "first");
    store.ingest(project, edit("A", "", "first"));
    const [text, presence] = file().hunks;
    expect(text!.ownership.owners).toEqual(["A"]);
    expect(presence!.ownership.owners).toEqual([null]);
    expect(text!.ownership.ties).toEqual(expect.arrayContaining(presence!.ownership.ties));
    put("empty", "");
    store.ingest(project, edit("A", null, "", "empty"));
    expect(owners("empty")).toEqual([["A"]]);
  });

  it("checks the file's type, reads symlink bytes as Other, and keeps chmod separate", () => {
    put("f", "base\n");
    commit();
    put("f", "A\n");
    chmodSync(join(root, "f"), 0o755);
    store.ingest(project, edit("A", "base\n", "A\n"));
    expect(file().hunks.map(({ kind, ownership }) => [kind, ownership.owners])).toEqual([
      ["content", ["A"]], ["mode", [null]],
    ]);
    put("referent", "A\n");
    unlinkSync(join(root, "f"));
    symlinkSync("referent", join(root, "f"));
    expect(store.ingest(project, edit("B", "A\n", "B\n")).results).toEqual(["rejected"]);
    const link = file();
    expect(link.current.kind).toBe("symlink");
    expect(link.hunks.some(({ kind }) => kind === "type")).toBe(true);
    expect(readWorkingEntry(project, "f")).toEqual({ kind: "symlink", bytes: Buffer.from("referent") });
  });

  it("commits neither half of an unproved move and ties both ends of an exact case-only move", () => {
    put("f", "base");
    commit();
    renameSync(join(root, "f"), join(root, "F"));
    put("F", "edited");
    expect(readWorkingEntry(project, "f")).toEqual({ kind: "absent" });
    const move = (from: string) => event("A", {
      path: join(root, "f"), from, to: null, move: { path: join(root, "F"), from: null, to: "edited" },
    });
    expect(store.ingest(project, move("wrong")).results).toEqual(["pending"]);
    expect(store.observe(project, ["f", "F"]).files.flatMap((value) => value.hunks)
      .every(({ ownership }) => ownership.owners.includes(null))).toBe(true);
    expect(store.ingest(project, move("base")).results).toEqual(["applied"]);
    const [source, dest] = store.observe(project, ["f", "F"]).files;
    expect(source!.moves).toEqual(dest!.moves);
    expect(source!.moves).toHaveLength(1);
    expect([...source!.hunks, ...dest!.hunks].every(({ ownership }) => ownership.owners.join() === "A")).toBe(true);
    expect(owners("F").every((labels) => labels.includes(null))).toBe(true);
  });

  it("compacts byte-stably and deduplicates native IDs after a new store starts", () => {
    put("f", Buffer.from([0xff, 13, 10]));
    commit();
    put("f", Buffer.from([0xff, 10, 0xf0]));
    const edit = event("A", { path: join(root, "f"), from: Uint8Array.of(0xff, 13, 10), to: Uint8Array.of(0xff, 10, 0xf0) });
    expect(store.ingest(project, edit).results).toEqual(["applied"]);
    const first = file();
    store.compact(project, ["f"]);
    store = new LedgerStore(new LedgerPersistence(journal));
    expect(store.ingest(project, { ...edit, changes: [] }).duplicate).toBe(true);
    expect(file()).toEqual(first);
    const saved = JSON.parse(readFileSync(journal, "utf8"));
    expect(saved.version).toBe(1);
    expect(Object.values(saved.projects[project.id].receipts)[0]).toMatchObject({
      executionId: "A", sessionId: edit.sessionId, toolCallId: edit.toolCallId,
    });
  });

  it("keeps a batch receipt across independent paths without using failed outcomes as evidence", () => {
    put("f", "base");
    put("g", "base");
    commit();
    put("f", "A");
    put("g", "B");
    const batch = event("A",
      { path: join(root, "f"), from: "base", to: "A" },
      { path: join(root, "g"), from: "unseen", to: "B" },
    );
    expect(store.ingest(project, batch).results).toEqual(["applied", "pending"]);
    store = new LedgerStore(new LedgerPersistence(journal));
    expect(store.ingest(project, batch)).toMatchObject({ duplicate: true, results: ["applied", "pending"] });
    expect(store.pending().executionIds).toEqual(["A"]);
    expect(store.ingest(project, { ...edit("B", "base", "B", "g"), outcome: "partial" }).results).toEqual([]);
    expect(owners("f")).toEqual([["A"]]);
    expect(owners("g")).toEqual([[null]]);
  });

  it("bounds unresolved versions and leaves over-budget files and events as Other", () => {
    put("f", "base");
    commit();
    const pending = edit("B", "missing", "B");
    store.ingest(project, pending);
    for (let index = 0; index < 22; index++) {
      put("f", "unknown " + index);
      expect(owners()).toEqual([[null]]);
    }
    expect(store.ingest(project, pending).results).toEqual(["expired"]);
    put("f", Buffer.alloc(MAX_FILE_BYTES + 1));
    expect(file().hunks[0]).toMatchObject({ kind: "opaque", reason: TOO_LARGE });
    expect(store.ingest(project, event("A", {
      path: join(root, "f"), from: null, to: Buffer.alloc(MAX_FILE_BYTES + 1),
    })).reason).toBe(TOO_LARGE);
    put("f", "base");
    expect(store.observe(project, ["f"]).files).toEqual([]);
    put("f", "small edit");
    store.ingest(project, edit("A", "base", "small edit"));
    expect(file().hunks).toHaveLength(1);
    expect(owners()).toEqual([["A"]]);
  });
});

describe("project identity and worker", () => {
  it("pins each scope and uses a separate identity for another worktree with the same common directory", () => {
    mkdirSync(join(root, "a"));
    mkdirSync(join(root, "b"));
    put("a/f", "base");
    commit();
    const a = discover(join(root, "a"));
    const b = discover(join(root, "b"));
    expect(a.id).toBe(b.id);
    expect(readBaseEntry(a, "a/f", readLedgerHead(a))).toEqual({ kind: "file", mode: "100644", bytes: Buffer.from("base") });
    const first = edit("A", "base", "written", "a/f");
    expect(store.ingest(a, first).results).toEqual(["applied"]);
    expect(() => store.ingest(b, first)).toThrow("Execution project scope changed");
    expect(store.ingest(b, edit("B", null, "", "a/f")).results).toEqual(["rejected"]);
    git("worktree", "add", "-qb", "other", join(folder, "other"));
    const other = discover(join(folder, "other"));
    expect(other.commonDir).toBe(a.commonDir);
    expect(other.id).not.toBe(a.id);
  });

  it("rejects malformed path/bytes, metadata, a symlink ancestor, and a nonregular index", () => {
    const outside = join(folder, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "f"), "existing");
    symlinkSync(outside, join(root, "outside"));
    for (const change of [
      { path: join(root, "outside/f"), from: "existing", to: "B" },
      { path: join(root, ".GIT/info/exclude"), from: "", to: "B" },
      { path: join(root, "f"), from: null, to: "\ud800" },
      { path: join(root, "\ud800"), from: null, to: "B" },
      { path: root + "/inside/../f", from: null, to: "B" },
      { path: join(outside, "f"), from: "existing", to: "B" },
    ]) expect(store.ingest(project, event("A", change)).results).toEqual(["rejected"]);
    symlinkSync(join(outside, "f"), join(project.gitDir, "index"));
    expect(discoverLedgerProject(root).reason).toContain("index is not a regular file");
    expect(readFileSync(join(outside, "f"), "utf8")).toBe("existing");
  });

  it("uses approved conversion and disables a repository fsmonitor hook", () => {
    put(".gitattributes", "f text eol=crlf\n");
    put("f", "α\n");
    commit();
    const marker = join(folder, "ran-hook");
    const hook = join(folder, "fsmonitor");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    git("config", "core.fsmonitor", hook);
    expect(readBaseEntry(project, "f", readLedgerHead(project))).toEqual({
      kind: "file", mode: "100644", bytes: Buffer.from("α\r\n"),
    });
    expect(() => readFileSync(marker)).toThrow();
  });

  it("drops ownership when HEAD absorbs it and does not revive it when HEAD moves back", () => {
    put("f", "base");
    commit();
    const base = git("rev-parse", "HEAD");
    put("f", "A");
    store.ingest(project, edit("A", "base", "A"));
    expect(owners()).toEqual([["A"]]);
    commit();
    expect(store.observe(project, ["f"])).toMatchObject({ headMoved: true, files: [] });
    git("reset", "--soft", base);
    expect(owners()).toEqual([[null]]);
  });

  it("reports exact snapshot fingerprints even after a clean chain is discarded", () => {
    put("f", "unchanged");
    commit();
    const view = store.observe(project, ["f"]);
    expect(view.files).toEqual([]);
    expect(view.head).toEqual(readLedgerHead(project));
    expect(view.snapshots).toEqual([{
      path: "f",
      current: { kind: "file", mode: "100644", blob: expect.stringMatching(/^[a-f0-9]{64}$/) },
      base: { kind: "file", mode: "100644", blob: expect.stringMatching(/^[a-f0-9]{64}$/) },
    }]);
    expect(view.snapshots[0]?.base).toEqual(view.snapshots[0]?.current);
  });

  it("resolves journal and content storage outside the worktree and Git metadata", () => {
    const inWorktree = new LedgerStore(new LedgerPersistence(join(root, "ledger.json")));
    expect(() => inWorktree.ingest(project, edit("A", null, "foo"))).toThrow("storage must be outside");
    symlinkSync(project.gitDir, join(folder, "alias"));
    const inGitDir = new LedgerStore(new LedgerPersistence(join(folder, "alias", "ledger.json")));
    expect(() => inGitDir.ingest(project, edit("A", null, "foo"))).toThrow("storage must be outside");
    expect(() => readFileSync(join(project.gitDir, "ledger.json"))).toThrow();
  });

  it("refuses substituted private content directories during receipt expiry and pruning", () => {
    put("f", "base");
    commit();
    expect(store.ingest(project, edit("A", "unseen", "A"), 100).results).toEqual(["pending"]);
    const directory = join(folder, "config", "ledger", project.id, "content");
    renameSync(directory, directory + "-original");
    symlinkSync(root, directory);
    const userPath = "a".repeat(64);
    put(userPath, "user data");
    expect(() => store.pending(100 + PENDING_MS)).toThrow("storage directory was substituted");
    expect(readFileSync(join(root, userPath), "utf8")).toBe("user data");
    expect(() => store.observe(project, ["f"])).toThrow("storage directory was substituted");
  });

  it("processes worker commands and makes completed receipts visible on restart", async () => {
    const client = new LedgerWorkerClient(journal);
    try {
      const found = await client.discover(root);
      expect(found.project?.id).toBe(project.id);
      put("f", "α\n");
      const batch = edit("A", null, "α\n");
      expect((await client.ingest(project, batch)).results).toEqual(["applied"]);
      expect((await client.observe(project, ["f"])).files[0]?.hunks[0]?.ownership.owners).toEqual(["A"]);
      expect((await client.pending()).executionIds).toEqual([]);
      expect(store.ingest(project, batch).duplicate).toBe(true);
    } finally {
      await client.close();
    }
  });
});
