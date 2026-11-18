import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runCommitTransaction, type CommitJournal, type CommitProject, type CommitRequest, type CommitTransactionPorts,
  type FrozenCommitComponent, type FrozenCommitSelection,
} from "./commitTransaction.ts";
import * as publication from "./gitPublication.ts";
import type { FrozenGitEntry } from "./gitTree.ts";

vi.setConfig({ testTimeout: 45_000 });
const dirs: string[] = [];
const templates = new Map<string, { root: string; base: string | null }>();
beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  for (const { root } of templates.values()) rmSync(root, { recursive: true, force: true });
});

function fixtureDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vizzo-transaction-")));
  dirs.push(dir);
  return dir;
}

function gitRun(root: string, args: string[]) {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    env: {
      ...process.env, GIT_INDEX_FILE: undefined, GIT_DIR: undefined,
      GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined, GIT_OPTIONAL_LOCKS: "0",
    },
    encoding: "utf8", timeout: 5_000,
  });
  if (result.error) throw result.error;
  return result;
}

function worktree(root: string, id: string, gitDir?: string) {
  function git(...args: string[]): string {
    const result = gitRun(root, args);
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trimEnd();
  }
  return {
    root, git,
    project: { id, root, commonDir: gitDir ?? git("rev-parse", "--path-format=absolute", "--git-common-dir") } satisfies CommitProject,
    index: gitDir ? join(gitDir, "index") : git("rev-parse", "--path-format=absolute", "--git-path", "index"),
    file(path: string, content: string) { writeFileSync(join(root, path), content); },
  };
}

function repo(format: "files" | "reftable", { unborn = false, sha256 = false } = {}) {
  const key = `${format}-${unborn}-${sha256}`;
  let template = templates.get(key);
  if (!template) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vizzo-transaction-template-")));
    template = { root, base: null };
    templates.set(key, template);
    const init = gitRun(root, ["init", "--quiet", "--template=", "--initial-branch=main", `--ref-format=${format}`,
      `--object-format=${sha256 ? "sha256" : "sha1"}`]);
    if (init.status !== 0) throw new Error(init.stderr);
    const fixture = worktree(root, "template", join(root, ".git"));
    fixture.git("config", "user.name", "Transaction Fixture");
    fixture.git("config", "user.email", "fixture@example.invalid");
    fixture.git("config", "commit.gpgSign", "false");
    if (!unborn) {
      fixture.file("main.txt", "base A\nseparator\nbase B\n");
      fixture.file("side.txt", "base side\n");
      fixture.file("assume.txt", "base assume\n");
      fixture.git("add", ".");
      fixture.git("commit", "--quiet", "-m", "Fixture base");
      template.base = fixture.git("rev-parse", "HEAD");
    }
  }
  const dir = fixtureDir();
  const root = join(dir, "repo");
  cpSync(template.root, root, { recursive: true, preserveTimestamps: true });
  return { ...worktree(root, "sample-project", join(root, ".git")), dir, base: template.base };
}

function frozenEntry(path = "main.txt", content = "selected A\nseparator\nbase B\n"): FrozenGitEntry {
  return { path, content: Buffer.from(content), kind: "partial", mode: "100644" };
}

const writerA = "writer-a";
const writerB = "writer-b";
const selectedComponent = "component-a";
const generation = 9;
const ownership = { eventIds: ["selected-edit"] };
type Ownership = typeof ownership;
type Journal = CommitJournal<Ownership>;
type Ports = CommitTransactionPorts<Ownership>;

function component(overrides: Partial<FrozenCommitComponent> = {}): FrozenCommitComponent {
  return { id: selectedComponent, writerIds: [writerA], other: false, incomplete: false, paths: ["main.txt"], ...overrides };
}

function job(project: CommitProject, options: {
  request?: Partial<CommitRequest>;
  frozen?: Partial<FrozenCommitSelection<Ownership>>;
  begin?: (record: Journal) => void | Promise<void>;
  journal?: (record: Journal) => void | Promise<void>;
  freeze?: NonNullable<Ports["scanAndFreeze"]>;
  settle?: (record: Journal) => void | Promise<void>;
} = {}) {
  const request: CommitRequest = {
    jobId: "commit-a", projectId: project.id, generation, componentIds: [selectedComponent], writerIds: [writerA],
    selection: { kind: "delete", writerId: writerA }, message: "Commit the selected changes", ...options.request,
  };
  const frozen: FrozenCommitSelection<Ownership> = {
    components: [component()], entries: [frozenEntry()], workingWriterIds: [], generation, ownership, ...options.frozen,
  };
  const history: Journal[] = [];
  const reserved = new Set<string>();
  let ledger = { record: null as Journal | null, closedGroup: true, ownedEvents: ["selected-edit", "other-writer-edit"] };
  const ports: Ports = {
    async begin(record) {
      if (ledger.record !== null) return false;
      await options.begin?.(record);
      history.push(structuredClone(record));
      ledger = { ...ledger, record: structuredClone(record) };
      return true;
    },
    async journal(record) {
      await options.journal?.(record);
      history.push(structuredClone(record));
      ledger = { ...ledger, record: structuredClone(record) };
    },
    async reserveWriters(context) {
      const prior = ledger.record;
      expect(prior).toMatchObject({ phase: "locking", step: "reserve-writers" });
      const stat = lstatSync(context.indexPath + ".lock", { bigint: true });
      expect(context.lock).toEqual({ device: String(stat.dev), inode: String(stat.ino) });
      expect(context.pid).toBe(process.pid);
      for (const writer of context.request.writerIds) reserved.add(writer);
      return () => reserved.clear();
    },
    async scanAndFreeze(context) {
      expect(ledger.record).toMatchObject({ phase: "locking", step: "freeze-selection" });
      expect([...reserved]).toEqual([...context.request.writerIds]);
      return options.freeze ? options.freeze(context) : frozen;
    },
    async settle(record) {
      expect(ledger.record).toMatchObject({ phase: "index-ready", step: "install", evidence: "published" });
      expect(existsSync(record.indexPath + ".lock")).toBe(false);
      expect([...reserved]).toEqual([...record.request.writerIds]);
      await options.settle?.(record);
      history.push(structuredClone(record));
      ledger = { record, closedGroup: false, ownedEvents: ledger.ownedEvents.filter((id) => !record.ownership.eventIds.includes(id)) };
    },
  };
  return { run: () => runCommitTransaction(project, request, ports), history, ledger: () => ledger, reserved };
}

function step(record: Journal): string {
  return "step" in record ? `${record.phase}/${record.step}` : record.phase;
}

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { open, wait };
}

const realPrepare = publication.prepareGitRefUpdate;
function interceptCommit(operation: (tx: publication.PreparedGitRefUpdate, input: {
  root: string; head: publication.GitHead; commit: string;
}) => Promise<publication.RefCommitResult>) {
  vi.spyOn(publication, "prepareGitRefUpdate").mockImplementationOnce(async (root, head, commit) => {
    const tx = await realPrepare(root, head, commit);
    return { ...tx, commit: () => operation(tx, { root, head, commit }) };
  });
}
const failedReceipt: publication.RefCommitResult = { kind: "failed", detail: "Injected Git commit failure" };

describe.each(["files", "reftable"] as const)("%s commit transaction", (format) => {
  it("commits the frozen selection while preserving another thread, unrelated staging, flags and worktree bytes", async () => {
    const fixture = repo(format);
    const { git, project, root, index, base } = fixture;
    const diskContent = "selected A\nseparator\nwriter B's later edit\n";
    fixture.file("main.txt", "selected A\nseparator\nbase B\n");
    fixture.file("side.txt", "user staging\n");
    git("add", "side.txt");
    fixture.file("side.txt", "unselected newer edit\n");
    git("update-index", "--assume-unchanged", "assume.txt");
    const flags = git("ls-files", "-v", "--", "assume.txt");
    const originalBytes = readFileSync(index);
    const entry = frozenEntry();
    const sourceOwnership = { eventIds: [...ownership.eventIds] };
    const transaction = job(project, {
      frozen: { entries: [entry], workingWriterIds: [writerB], ownership: sourceOwnership },
      journal(record) {
        switch (step(record)) {
          case "locking/acquire-index":
            expect(existsSync(index + ".lock")).toBe(false);
            break;
          case "locking/validate-selection":
            entry.content?.fill(0x78);
            sourceOwnership.eventIds.push("other-writer-edit");
            fixture.file("main.txt", diskContent);
            break;
          case "publishing/prepare-index":
            expect(gitRun(root, ["symbolic-ref", "HEAD", "refs/heads/wrong"]).status).not.toBe(0);
            expect(gitRun(root, ["checkout", "-qb", "wrong"]).status).not.toBe(0);
            expect(git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
            break;
          case "index-ready/publish":
            expect(readFileSync(index + ".lock").subarray(0, 4).toString("ascii")).toBe("DIRC");
            expect(readFileSync(index)).toEqual(originalBytes);
            expect(git("rev-parse", "HEAD")).toBe(base);
            break;
          case "index-ready/install":
            expect(record).toMatchObject({ receipt: { kind: "acknowledged" }, evidence: "published" });
            expect(readFileSync(index)).toEqual(originalBytes);
            break;
        }
      },
    });
    const result = await transaction.run();
    expect(result).toEqual({ status: "done", commit: git("rev-parse", "HEAD") });
    expect(git("rev-parse", "HEAD^")).toBe(base);
    expect(git("show", "HEAD:main.txt")).toBe("selected A\nseparator\nbase B");
    expect(git("diff", "--cached", "--name-only")).toBe("side.txt");
    expect(git("show", ":side.txt")).toBe("user staging");
    expect(git("ls-files", "-v", "--", "assume.txt")).toBe(flags);
    expect(readFileSync(join(root, "main.txt"), "utf8")).toBe(diskContent);
    expect(readFileSync(join(root, "side.txt"), "utf8")).toBe("unselected newer edit\n");
    expect(transaction.ledger()).toMatchObject({ closedGroup: false, ownedEvents: ["other-writer-edit"] });
    expect(transaction.reserved.size).toBe(0);
    const completed = transaction.ledger();
    await expect(transaction.run()).resolves.toMatchObject({ status: "refused", code: "duplicate-job" });
    expect(transaction.ledger()).toBe(completed);
    expect(existsSync(index + ".lock")).toBe(false);
    expect(transaction.history.map(step)).toEqual([
      "locking/resolve-index", "locking/acquire-index", "locking/capture-base", "locking/reserve-writers", "locking/freeze-selection",
      "locking/validate-selection", "locking/build-commit", "publishing/prepare-ref", "publishing/prepare-index",
      "publishing/write-index", "index-ready/publish", "index-ready/classify", "index-ready/install", "done",
    ]);
  });

  it("refuses staging on the selected path without touching the index", async () => {
    const fixture = repo(format);
    fixture.file("main.txt", "index content\n");
    fixture.git("add", "main.txt");
    fixture.file("main.txt", "working content\n");
    const before = readFileSync(fixture.index);
    const transaction = job(fixture.project);
    await expect(transaction.run()).resolves.toMatchObject({ status: "refused", reason: 'This path has staged changes: "main.txt"' });
    expect(fixture.git("rev-parse", "HEAD")).toBe(fixture.base);
    expect(readFileSync(fixture.index)).toEqual(before);
    expect(existsSync(fixture.index + ".lock")).toBe(false);
    expect(transaction.ledger()).toMatchObject({ record: { phase: "refused" }, closedGroup: true });
  });

  it("refuses the entire selection when conversion leaves one selected entry equal to its base", async () => {
    const { git, file, project, index } = repo(format);
    file(".gitattributes", "*.txt text\n");
    git("add", ".gitattributes");
    git("commit", "-qm", "Base text attributes");
    const base = git("rev-parse", "HEAD");
    const before = readFileSync(index);
    const crlf = "base A\r\nseparator\r\nbase B\r\n";
    file(".gitattributes", "*.txt -text\n");
    file("main.txt", crlf);
    file("side.txt", "Selected real change\n");
    expect(git("status", "--porcelain", "--", "main.txt")).toContain("M main.txt");
    const transaction = job(project, {
      frozen: {
        components: [component({ paths: ["main.txt", "side.txt"] })],
        entries: [{ ...frozenEntry("main.txt", crlf), kind: "whole" }, frozenEntry("side.txt", "Selected real change\n")],
      },
    });
    await expect(transaction.run()).resolves.toMatchObject({ status: "refused", code: "unchanged-entry", reason: expect.stringContaining("main.txt") });
    expect(transaction.history.map(step)).not.toContain("publishing/prepare-ref");
    expect(transaction.ledger()).toMatchObject({ record: { phase: "refused", ownership }, closedGroup: true,
      ownedEvents: ["selected-edit", "other-writer-edit"] });
    expect(git("rev-parse", "HEAD")).toBe(base);
    expect(readFileSync(index)).toEqual(before);
    expect(existsSync(index + ".lock")).toBe(false);
  });

  it("isolates transaction snapshots from mutations by journal callbacks", async () => {
    const { git, project, index, base } = repo(format);
    let publishedEntries: unknown;
    const transaction = job(project, {
      begin(record) {
        Object.assign(record.project, { root: "/missing" });
        (record.request.componentIds as string[]).push("injected");
      },
      journal(record) {
        if (record.phase === "locking" && record.step === "reserve-writers") {
          Object.assign(record.lock, { inode: "foreign" });
          Object.assign(record.head, { oid: "0".repeat(40) });
          (record.request.writerIds as string[]).push(writerB);
        }
        if (record.phase === "publishing" && record.step === "prepare-ref") {
          record.ownership.eventIds.push("wrong-writer-edit");
          Object.assign(record.entries[0]?.next ?? {}, { oid: "0".repeat(40), mode: "100755" });
          (record.request.componentIds as string[]).push("another-component");
        }
        if (record.phase === "index-ready" && record.step === "install") publishedEntries = structuredClone(record.entries);
      },
      settle(record) {
        expect(record).toMatchObject({ ownership, entries: publishedEntries });
        expect(record.request.writerIds).toEqual([writerA]);
        expect(record.request.componentIds).toEqual([selectedComponent]);
        expect(git("show", ":main.txt")).toBe("selected A\nseparator\nbase B");
      },
    });
    await expect(transaction.run()).resolves.toMatchObject({ status: "done" });
    expect(git("rev-parse", "HEAD^")).toBe(base);
    expect(git("show", "HEAD:main.txt")).toBe(git("show", ":main.txt"));
    expect(transaction.ledger()).toMatchObject({ ownedEvents: ["other-writer-edit"] });
    expect(existsSync(index + ".lock")).toBe(false);
  });

  it.each([
    { name: "a stale generation", request: {}, frozen: { generation: generation - 1 }, code: "stale" },
    { name: "a newly tied writer", request: {}, frozen: { components: [component({ writerIds: [writerA, writerB] })] }, code: "stale" },
    { name: "a selected working writer", request: { writerIds: [writerA, writerB] }, frozen: {
      components: [component({ writerIds: [writerA, writerB] })], workingWriterIds: [writerB],
    }, code: "working" },
    { name: "unticked Other", request: { selection: { kind: "explicit", otherComponentIds: [] } },
      frozen: { components: [component({ other: true })] }, code: "other" },
    { name: "Other in a writer-scoped selection", request: { selection: { kind: "writer", writerId: writerA } },
      frozen: { components: [component({ other: true })] }, code: "other" },
    { name: "tied work in a writer-scoped selection", request: { selection: { kind: "writer", writerId: writerA }, writerIds: [writerA, writerB] },
      frozen: { components: [component({ writerIds: [writerA, writerB] })] }, code: "selection" },
    { name: "tied work on delete", request: { writerIds: [writerA, writerB] },
      frozen: { components: [component({ writerIds: [writerA, writerB] })] }, code: "delete-selection" },
    { name: "Other on delete", request: {}, frozen: { components: [component({ other: true })] }, code: "delete-selection" },
    { name: "incomplete work on delete", request: {}, frozen: { components: [component({ incomplete: true })] }, code: "delete-selection" },
    { name: "a frozen path outside the selection", request: {}, frozen: { entries: [frozenEntry(), frozenEntry("side.txt")] }, code: "stale" },
  ] as const)("refuses $name before building a commit", async ({ request, frozen, code }) => {
    const { project, index, git, base } = repo(format);
    const before = readFileSync(index);
    const transaction = job(project, { request, frozen });
    await expect(transaction.run()).resolves.toMatchObject({ status: "refused", code });
    expect(transaction.history.map(step)).not.toContain("locking/build-commit");
    expect(transaction.ledger()).toMatchObject({ closedGroup: true, ownedEvents: ["selected-edit", "other-writer-edit"] });
    expect(git("rev-parse", "HEAD")).toBe(base);
    expect(readFileSync(index)).toEqual(before);
    expect(existsSync(index + ".lock")).toBe(false);
    expect(transaction.reserved.size).toBe(0);
  });

  it("allows explicit ties, ticked Other and incomplete work through the Changes window selection", async () => {
    const { project, git } = repo(format);
    const transaction = job(project, {
      request: { selection: { kind: "explicit", otherComponentIds: [selectedComponent] }, writerIds: [writerA, writerB] },
      frozen: { components: [component({ writerIds: [writerA, writerB], other: true, incomplete: true })] },
    });
    await expect(transaction.run()).resolves.toMatchObject({ status: "done" });
    expect(git("show", "HEAD:main.txt")).toContain("selected A");
  });

  it("serializes linked worktrees, holds reservations through settlement and lets another repository proceed", async () => {
    const fixture = repo(format);
    const linkedRoot = join(fixture.dir, "linked");
    fixture.git("worktree", "add", "-b", "linked", linkedRoot);
    const linked = worktree(linkedRoot, "linked-project");
    const independent = repo(format);
    const entered = gate();
    const settle = gate();
    const events: string[] = [];
    const first = job(fixture.project, {
      async settle() {
        events.push("first settling");
        entered.open();
        await settle.wait;
        events.push("first settled");
      },
    });
    const second = job(linked.project, {
      begin: (record) => { events.push(`second ${step(record)}`); },
      journal: (record) => { events.push(`second ${step(record)}`); },
    });
    const pendingFirst = first.run();
    await Promise.race([
      entered.wait,
      pendingFirst.then((result) => { throw new Error(`First commit ended before settlement: ${JSON.stringify(result)}`); }),
    ]);
    const pendingSecond = second.run();
    try {
      await expect(job(independent.project).run()).resolves.toMatchObject({ status: "done" });
      expect(first.reserved).toEqual(new Set([writerA]));
      expect(second.history).toEqual([]);
    } finally { settle.open(); }
    await expect(pendingFirst).resolves.toMatchObject({ status: "done" });
    await expect(pendingSecond).resolves.toMatchObject({ status: "done" });
    expect(events.slice(0, 3)).toEqual(["first settling", "first settled", "second locking/resolve-index"]);
    expect(first.reserved.size).toBe(0);
  });

  it("publishes an unborn SHA-256 branch and installs its first index", async () => {
    const fixture = repo(format, { unborn: true, sha256: true });
    fixture.file("main.txt", "new file\n");
    expect(existsSync(fixture.index)).toBe(false);
    const transaction = job(fixture.project, {
      frozen: { entries: [{ ...frozenEntry("main.txt", "new file\n"), kind: "whole" }] },
    });
    const head = await transaction.run();
    expect(head).toEqual({ status: "done", commit: fixture.git("rev-parse", "HEAD") });
    expect(fixture.git("rev-list", "--count", "HEAD")).toBe("1");
    expect(fixture.git("show", ":main.txt")).toBe("new file");
    expect(transaction.ledger().record).toMatchObject({ head: { oid: null, branch: "refs/heads/main" } });
  });

  it.each(["old OID changed", "same OID and different branch"])("refuses prepare when %s", async (change) => {
    const { git, project, index, base } = repo(format);
    const before = readFileSync(index);
    const moved = git("commit-tree", git("rev-parse", "HEAD^{tree}"), "-p", base!, "-m", "External commit");
    git("branch", "other", base!);
    const transaction = job(project, {
      journal(record) {
        if (step(record) !== "publishing/prepare-ref") return;
        if (change === "old OID changed") git("update-ref", "HEAD", moved, base!);
        else git("symbolic-ref", "HEAD", "refs/heads/other");
      },
    });
    await expect(transaction.run()).resolves.toEqual({ status: "refused", code: "head-moved", reason: "HEAD moved: review again" });
    expect(git("rev-parse", "HEAD")).toBe(change === "old OID changed" ? moved : base);
    expect(git("rev-parse", "refs/heads/other")).toBe(base);
    expect(transaction.history.map(step).slice(-3)).toEqual(["publishing/prepare-ref", "publishing/cleanup", "refused"]);
    expect(readFileSync(index)).toEqual(before);
    expect(existsSync(index + ".lock")).toBe(false);
  });

  it("aborts the prepared ref and releases its index lock on a pre-publication error", async () => {
    const { git, project, index, base, root } = repo(format);
    const before = readFileSync(index);
    const transaction = job(project, {
      journal(record) {
        if (step(record) === "publishing/write-index") throw new Error("Injected preparation error");
        if (step(record) === "publishing/cleanup") {
          expect(gitRun(root, ["symbolic-ref", "HEAD", "refs/heads/other"]).status).not.toBe(0);
          expect(existsSync(index + ".lock")).toBe(true);
        }
        if (record.phase === "refused") expect(existsSync(index + ".lock")).toBe(false);
      },
    });
    await expect(transaction.run()).resolves.toMatchObject({ status: "refused", reason: "Injected preparation error" });
    expect(git("rev-parse", "HEAD")).toBe(base);
    git("symbolic-ref", "HEAD", "refs/heads/other");
    expect(readFileSync(index)).toEqual(before);
    expect(transaction.reserved.size).toBe(0);
  });

  it("aborts publication if the final checkpoint loses the index lock to newer user staging", async () => {
    const { git, file, project, index, base } = repo(format);
    const lock = index + ".lock";
    let userIndex: Buffer | undefined;
    let userLock: bigint | undefined;
    const transaction = job(project, {
      journal(record) {
        if (step(record) !== "index-ready/publish") return;
        renameSync(lock, lock + "-saved");
        file("main.txt", "Newer user staging\n");
        git("add", "main.txt");
        userIndex = readFileSync(index);
        writeFileSync(lock, "A foreign index lock");
        userLock = lstatSync(lock, { bigint: true }).ino;
      },
    });
    await expect(transaction.run()).resolves.toMatchObject({ status: "refused", code: "index-lock-lost" });
    expect(git("rev-parse", "HEAD")).toBe(base);
    expect(git("show", ":main.txt")).toBe("Newer user staging");
    expect(readFileSync(index)).toEqual(userIndex);
    expect(lstatSync(lock, { bigint: true }).ino).toBe(userLock);
    expect(readFileSync(lock, "utf8")).toBe("A foreign index lock");
    expect(transaction.ledger()).toMatchObject({ record: { phase: "refused" }, closedGroup: true });
    expect(transaction.history.map(step)).not.toContain("index-ready/classify");
  });

  it("leaves the original index byte-identical after a failed publication with no ref or reflog change", async () => {
    const { git, project, index, base } = repo(format);
    const before = readFileSync(index);
    interceptCommit(async (tx) => { await tx.abort(); return failedReceipt; });
    const transaction = job(project, {
      journal(record) {
        if (step(record) === "index-ready/release") expect(existsSync(index + ".lock")).toBe(true);
        if (record.phase === "not-published") expect(existsSync(index + ".lock")).toBe(false);
      },
    });
    await expect(transaction.run()).resolves.toMatchObject({ status: "not-published" });
    expect(transaction.ledger()).toMatchObject({ record: { phase: "not-published", receipt: failedReceipt }, closedGroup: true });
    expect(git("rev-parse", "HEAD")).toBe(base);
    expect(readFileSync(index)).toEqual(before);
  });

  it("installs the index when the failed receipt is followed by reachable publication evidence", async () => {
    const { git, project } = repo(format);
    interceptCommit(async (tx) => {
      expect(await tx.commit()).toEqual({ kind: "acknowledged" });
      const published = git("rev-parse", "HEAD");
      const descendant = git("commit-tree", git("rev-parse", "HEAD^{tree}"), "-p", published, "-m", "External descendant");
      git("update-ref", "HEAD", descendant, published);
      return failedReceipt;
    });
    const transaction = job(project);
    const result = await transaction.run();
    expect(result).toEqual({ status: "done", commit: git("rev-parse", "HEAD^") });
    expect(transaction.ledger()).toMatchObject({ record: { phase: "done", receipt: failedReceipt, evidence: "published" }, closedGroup: false });
    expect(git("show", ":main.txt")).toContain("selected A");
  });

  it("retains ownership and closed group when the only evidence is a reflog entry", async () => {
    const { git, project, index, base } = repo(format);
    const before = readFileSync(index);
    interceptCommit(async (tx, { head, commit }) => {
      await tx.abort();
      git("reflog", "write", head.branch, base!, commit, "Injected reflog-only failure");
      return failedReceipt;
    });
    const transaction = job(project);
    const result = await transaction.run();
    expect(result).toMatchObject({ status: "indeterminate" });
    expect(transaction.ledger()).toMatchObject({ record: { phase: "indeterminate", receipt: failedReceipt }, closedGroup: true,
      ownedEvents: ["selected-edit", "other-writer-edit"] });
    expect(git("rev-parse", "HEAD")).toBe(base);
    expect(readFileSync(index)).toEqual(before);
    expect(existsSync(index + ".lock")).toBe(false);
  });

  it("honors the publication ACK after a soft reset between commit and evidence collection", async () => {
    const { git, project, base } = repo(format);
    interceptCommit(async (tx) => {
      const receipt = await tx.commit();
      expect(receipt).toEqual({ kind: "acknowledged" });
      git("reset", "--soft", "HEAD^");
      return receipt;
    });
    const transaction = job(project);
    await expect(transaction.run()).resolves.toMatchObject({ status: "done" });
    expect(git("rev-parse", "HEAD")).toBe(base);
    expect(git("diff", "--cached", "--name-only")).toBe("main.txt");
    expect(git("show", ":main.txt")).toContain("selected A");
    expect(transaction.ledger().record).toMatchObject({ phase: "done", receipt: { kind: "acknowledged" } });
  });

  it("journals confirmed index repair before releasing a matching lock and keeps the ledger ownership", async () => {
    const { project, git, index, base } = repo(format);
    const before = readFileSync(index);
    const transaction = job(project, {
      journal(record) {
        if (step(record) === "index-ready/install") {
          renameSync(index, index + "-original");
          symlinkSync(index + "-original", index);
        }
        if (step(record) === "index-ready/repair") expect(existsSync(index + ".lock")).toBe(true);
      },
    });
    const result = await transaction.run();
    expect(result).toMatchObject({ status: "repair-needed", commit: git("rev-parse", "HEAD") });
    expect(transaction.ledger()).toMatchObject({ record: {
      phase: "index-ready", step: "repair", head: { oid: base }, evidence: "published", receipt: { kind: "acknowledged" },
      entries: [{ path: "main.txt", base: { mode: "100644" }, next: { mode: "100644" } }],
    }, closedGroup: true, ownedEvents: ["selected-edit", "other-writer-edit"] });
    expect(readFileSync(index)).toEqual(before);
    expect(lstatSync(index).isSymbolicLink()).toBe(true);
    expect(existsSync(index + ".lock")).toBe(false);
  });

  it("retains the repair checkpoint if index installation throws after the rename", async () => {
    const { project, git, index } = repo(format);
    const install = publication.IndexLock.prototype.install;
    vi.spyOn(publication.IndexLock.prototype, "install").mockImplementationOnce(async function (this: publication.IndexLock, evidence) {
      await install.call(this, evidence);
      throw new Error("Injected directory sync failure after index rename");
    });
    const transaction = job(project);
    const result = await transaction.run();
    const published = git("rev-parse", "HEAD");
    expect(result).toMatchObject({ status: "repair-needed", commit: published });
    expect(git("show", ":main.txt")).toBe(git("show", "HEAD:main.txt"));
    expect(git("diff", "--cached", "--name-only")).toBe("");
    expect(existsSync(index + ".lock")).toBe(false);
    expect(transaction.ledger()).toMatchObject({ record: {
      phase: "index-ready", step: "repair", commit: published, evidence: "published",
      reason: expect.stringContaining("couldn't confirm the staging area update"),
    }, closedGroup: true, ownedEvents: ["selected-edit", "other-writer-edit"] });
  });

  it("preserves the prepared owned lock when the post-publish journal write fails", async () => {
    const { project, git, index, base } = repo(format);
    const before = readFileSync(index);
    const transaction = job(project, {
      journal(record) {
        if (step(record) === "index-ready/classify") throw new Error("Injected fsync failure after ACK");
      },
    });
    await expect(transaction.run()).rejects.toThrow("Injected fsync failure after ACK");
    const stat = lstatSync(index + ".lock", { bigint: true });
    expect(transaction.ledger()).toMatchObject({ record: {
      phase: "index-ready", step: "publish", commit: git("rev-parse", "HEAD"), head: { oid: base },
      lock: { device: String(stat.dev), inode: String(stat.ino) },
    }, closedGroup: true });
    expect(readFileSync(index)).toEqual(before);
    const durableBeforeRetry = transaction.ledger();
    const historyLength = transaction.history.length;
    const preparedBytes = readFileSync(index + ".lock");
    expect(preparedBytes.subarray(0, 4).toString("ascii")).toBe("DIRC");
    await expect(transaction.run()).resolves.toMatchObject({ status: "refused", code: "duplicate-job" });
    expect(transaction.ledger()).toBe(durableBeforeRetry);
    expect(transaction.history).toHaveLength(historyLength);
    expect(lstatSync(index + ".lock", { bigint: true }).ino).toBe(stat.ino);
    expect(readFileSync(index + ".lock")).toEqual(preparedBytes);
    expect(transaction.reserved.size).toBe(0);
  });

  it("keeps the published repair checkpoint when atomic ledger settlement fails after index installation", async () => {
    const { project, git, index } = repo(format);
    const transaction = job(project, { settle() { throw new Error("Injected atomic settlement failure"); } });
    await expect(transaction.run()).rejects.toThrow("Injected atomic settlement failure");
    expect(transaction.ledger()).toMatchObject({ record: { phase: "index-ready", step: "install", evidence: "published" },
      closedGroup: true, ownedEvents: ["selected-edit", "other-writer-edit"] });
    expect(existsSync(index + ".lock")).toBe(false);
    expect(git("show", ":main.txt")).toContain("selected A");
    expect(transaction.reserved.size).toBe(0);
  });

  it("honors signing configuration without running Git hooks", async () => {
    const { dir, git, project } = repo(format);
    const hooks = join(dir, "hooks");
    const marker = join(dir, "hook-ran");
    const key = join(dir, "test-signing-key");
    mkdirSync(hooks);
    for (const name of ["pre-commit", "commit-msg", "reference-transaction", "post-index-change", "fsmonitor"]) {
      writeFileSync(join(hooks, name), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
    }
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { stdio: "pipe" });
    git("config", "gpg.format", "ssh");
    git("config", "user.signingKey", key);
    git("config", "commit.gpgSign", "true");
    git("config", "core.hooksPath", hooks);
    git("config", "core.fsmonitor", join(hooks, "fsmonitor"));
    await expect(job(project).run()).resolves.toMatchObject({ status: "done" });
    expect(git("cat-file", "commit", "HEAD")).toContain("gpgsig -----BEGIN SSH SIGNATURE-----");
    expect(existsSync(marker)).toBe(false);
  });
});

it("preserves indeterminate state after a genuine files-backend reflog write failure", async () => {
  const { git, project, index, base } = repo("files");
  const before = readFileSync(index);
  const transaction = job(project, {
    journal(record) {
      if (step(record) !== "index-ready/publish") return;
      const path = git("rev-parse", "--path-format=absolute", "--git-path", "logs/refs/heads/main");
      renameSync(path, path + "-saved");
      mkdirSync(path);
      writeFileSync(join(path, "blocker"), "prevent Git from replacing the directory");
    },
  });
  const result = await transaction.run();
  expect(result).toMatchObject({ status: "indeterminate" });
  expect(transaction.ledger()).toMatchObject({ record: { phase: "indeterminate", receipt: { kind: "failed" } }, closedGroup: true });
  expect(git("rev-parse", "HEAD")).toBe(base);
  if (result.status !== "indeterminate") throw new Error("Expected an indeterminate publish");
  expect(git("reflog", "show", "--format=%H", "HEAD").split("\n")).toContain(result.commit);
  expect(readFileSync(index)).toEqual(before);
  expect(existsSync(index + ".lock")).toBe(false);
});
