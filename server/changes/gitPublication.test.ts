import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireIndexLock, captureGitHead, classifyGitPublication, gitIndexPath, prepareGitRefUpdate, prepareGitRefVerify, reopenIndexLock,
  type IndexLock, type PreparedGitRefVerification, type RefCommitResult,
} from "./gitPublication.ts";

vi.setConfig({ testTimeout: 15_000 });
const testGitEnv = {
  ...process.env,
  GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined, GIT_DIR: undefined,
  GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_NAMESPACE: undefined,
  GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined, GIT_QUARANTINE_PATH: undefined,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0",
};
const dirs: string[] = [];
const locks: IndexLock[] = [];
const transactions: PreparedGitRefVerification[] = [];

afterEach(async () => {
  for (const tx of transactions.splice(0)) await tx.close();
  for (const lock of locks.splice(0)) await lock.release();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(cwd: string, args: string[], input?: string, overrides?: NodeJS.ProcessEnv) {
  const result = spawnSync("git", ["-c", "user.name=Vizzo Test", "-c", "user.email=vizzo@example.invalid", ...args], {
    cwd, input, encoding: "utf8", timeout: 5_000,
    env: { ...testGitEnv, ...overrides },
  });
  if (result.error) throw result.error;
  return result;
}

function git(cwd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): string {
  const result = run(cwd, args, input, env);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} returned ${result.status}\n${result.stderr}`);
  return result.stdout.trimEnd();
}

function repo(format: "files" | "reftable", objectFormat = "sha1"): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "vizzo-publication-")));
  dirs.push(cwd);
  git(cwd, ["init", "-q", "--template=", "--initial-branch=main", `--ref-format=${format}`, `--object-format=${objectFormat}`]);
  return cwd;
}

function newCommit(cwd: string, content: string, parent?: string): string {
  const blob = git(cwd, ["hash-object", "-w", "--stdin"], content);
  const tree = git(cwd, ["mktree"], `100644 blob ${blob}\ttracked.txt\n`);
  return git(cwd, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", content]);
}

function startRepo(format: "files" | "reftable") {
  const cwd = repo(format);
  const base = newCommit(cwd, "base\n");
  git(cwd, ["update-ref", "HEAD", base]);
  git(cwd, ["read-tree", base]);
  writeFileSync(join(cwd, "tracked.txt"), "unsaved work\n");
  return { cwd, base, commit: newCommit(cwd, "selected\n", base) };
}

function preparedIndex(cwd: string, commit: string): Buffer {
  const index = join(cwd, "prepared-index");
  git(cwd, ["read-tree", commit], undefined, { GIT_INDEX_FILE: index });
  return readFileSync(index);
}

async function take(cwd: string, waitMs?: number): Promise<IndexLock> {
  const lock = await acquireIndexLock(await gitIndexPath(cwd), waitMs);
  locks.push(lock);
  return lock;
}

function retain<T extends PreparedGitRefVerification>(tx: T): T {
  transactions.push(tx);
  return tx;
}

const failed: RefCommitResult = { kind: "failed", detail: "Injected failure at the commit observation boundary" };

describe.each(["files", "reftable"] as const)("%s ref format", (format) => {
  it("retries for an external lock, leaves a busy lock alone, and keeps the real index byte-identical", async () => {
    const { cwd } = startRepo(format);
    const index = await gitIndexPath(cwd);
    const path = index + ".lock";
    const before = readFileSync(index);
    writeFileSync(path, "external Git lock");
    await expect(acquireIndexLock(index, 75)).rejects.toMatchObject({ code: "busy" });
    expect(readFileSync(path, "utf8")).toBe("external Git lock");
    expect(readFileSync(index)).toEqual(before);

    const acquiring = take(cwd, 1_000);
    const releasing = delay(100).then(() => rmSync(path));
    const [lock] = await Promise.all([acquiring, releasing]);
    expect(run(cwd, ["add", "tracked.txt"]).status).not.toBe(0);
    expect(await lock.release()).toBe(true);
    expect(readFileSync(index)).toEqual(before);
  });

  it("records a lock's device and inode and preserves a replacement lock", async () => {
    const { cwd } = startRepo(format);
    const lock = await take(cwd);
    const path = lock.indexPath + ".lock";
    const stat = lstatSync(path, { bigint: true });
    expect(lock.identity).toEqual({ device: String(stat.dev), inode: String(stat.ino) });
    renameSync(path, path + "-original");
    writeFileSync(path, "foreign replacement");
    await expect(lock.write(Buffer.from("prepared bytes"))).rejects.toMatchObject({ code: "index-lock-lost" });
    await expect(lock.install("published")).rejects.toMatchObject({ code: "index-lock-lost" });
    expect(await lock.release()).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("foreign replacement");
  });

  it("only reopens a journaled lock with matching identity and an exited owner", async () => {
    const { cwd, commit } = startRepo(format);
    const lock = await take(cwd);
    const bytes = preparedIndex(cwd, commit);
    await lock.write(bytes);
    await expect(reopenIndexLock(lock.indexPath, { ...lock.identity, pid: process.pid })).resolves.toBeNull();

    const dead = spawnSync(process.execPath, ["-e", ""]);
    expect(dead.status).toBe(0);
    expect(dead.pid).toBeGreaterThan(0);
    await lock.close();
    await expect(reopenIndexLock(lock.indexPath, { ...lock.identity, inode: "0", pid: dead.pid })).resolves.toBeNull();
    const recovered = await reopenIndexLock(lock.indexPath, { ...lock.identity, pid: dead.pid });
    expect(recovered).not.toBeNull();
    locks.push(recovered!);
    expect(readFileSync(lock.indexPath + ".lock")).toEqual(bytes);
    expect(await recovered!.release()).toBe(true);
  });

  it("refuses a symlink index and preserves the actual index and symlink", async () => {
    const { cwd } = startRepo(format);
    const index = await gitIndexPath(cwd);
    const realIndex = index + "-actual";
    const before = readFileSync(index);
    renameSync(index, realIndex);
    symlinkSync(realIndex, index);
    await expect(acquireIndexLock(index)).rejects.toMatchObject({ code: "index-layout" });
    expect(lstatSync(index).isSymbolicLink()).toBe(true);
    expect(existsSync(index + ".lock")).toBe(false);
    expect(readFileSync(realIndex)).toEqual(before);
  });

  it("checks the real index is still regular before installation", async () => {
    const { cwd, commit } = startRepo(format);
    const lock = await take(cwd);
    await lock.write(preparedIndex(cwd, commit));
    const realIndex = lock.indexPath + "-actual";
    const before = readFileSync(lock.indexPath);
    renameSync(lock.indexPath, realIndex);
    symlinkSync(realIndex, lock.indexPath);
    await expect(lock.install("published")).rejects.toMatchObject({ code: "index-layout" });
    expect(lstatSync(lock.indexPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(realIndex)).toEqual(before);
  });

  it("uses the linked worktree's own index when invoked from a subfolder", async () => {
    const { cwd, base } = startRepo(format);
    const worktree = join(cwd, "linked worktree");
    git(cwd, ["worktree", "add", "-b", "linked", worktree, base]);
    const project = join(worktree, "project");
    mkdirSync(project);
    const localIndex = await gitIndexPath(project);
    expect(localIndex).not.toEqual(await gitIndexPath(cwd));
    const lock = await take(project);
    expect(lock.indexPath).toBe(localIndex);
    expect(await captureGitHead(project)).toEqual({ branch: "refs/heads/linked", oid: base });
    expect(await lock.release()).toBe(true);
  });

  it("rejects detached and indirect symbolic HEAD", async () => {
    const { cwd, base, commit } = startRepo(format);
    git(cwd, ["update-ref", "--no-deref", "HEAD", base]);
    await expect(captureGitHead(cwd)).rejects.toMatchObject({ code: "detached-head" });
    git(cwd, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    const original = await captureGitHead(cwd);
    git(cwd, ["branch", "other", base]);
    git(cwd, ["symbolic-ref", "refs/heads/main", "refs/heads/other"]);
    await expect(captureGitHead(cwd)).rejects.toMatchObject({ code: "head-layout" });
    await expect(prepareGitRefUpdate(cwd, original, commit)).rejects.toMatchObject({ code: "head-moved" });
    expect(git(cwd, ["rev-parse", "refs/heads/other"])).toBe(base);
  });

  it("keeps a trailing Unicode space in the branch name", async () => {
    const { cwd, base, commit } = startRepo(format);
    const branch = "refs/heads/main\u00a0";
    git(cwd, ["update-ref", branch, base]);
    git(cwd, ["symbolic-ref", "HEAD", branch]);
    const original = await captureGitHead(cwd);
    expect(original).toEqual({ branch, oid: base });
    const receipt = await retain(await prepareGitRefUpdate(cwd, original, commit)).commit();
    expect(receipt.kind).toBe("acknowledged");
    expect(git(cwd, ["rev-parse", branch])).toBe(commit);
    expect(git(cwd, ["rev-parse", "refs/heads/main"])).toBe(base);
  });

  it("refuses a ref name that cannot round-trip through UTF-8", async () => {
    const cwd = repo(format);
    const result = spawnSync("sh", ["-c", 'git symbolic-ref HEAD "refs/heads/invalid-$(printf \'\\377\')"'], {
      cwd, encoding: "utf8", env: testGitEnv,
    });
    expect(result.status, result.stderr).toBe(0);
    await expect(captureGitHead(cwd)).rejects.toMatchObject({ code: "head-layout" });
  });

  it("aborts when a same-OID branch was checked out after capture", async () => {
    const { cwd, base, commit } = startRepo(format);
    git(cwd, ["branch", "other", base]);
    const original = await captureGitHead(cwd);
    git(cwd, ["checkout", "-q", "other"]);
    await expect(prepareGitRefUpdate(cwd, original, commit)).rejects.toMatchObject({ code: "head-moved" });
    expect(git(cwd, ["rev-parse", "HEAD"])).toBe(base);
    expect(git(cwd, ["rev-parse", "refs/heads/main"])).toBe(base);
    await retain(await prepareGitRefVerify(cwd, await captureGitHead(cwd))).abort();
  });

  it("refuses if the old OID no longer matches", async () => {
    const { cwd, base, commit } = startRepo(format);
    const original = await captureGitHead(cwd);
    const moved = newCommit(cwd, "external\n", base);
    git(cwd, ["update-ref", "HEAD", moved]);
    await expect(prepareGitRefUpdate(cwd, original, commit)).rejects.toMatchObject({ code: "head-moved" });
    await expect(prepareGitRefVerify(cwd, original)).rejects.toMatchObject({ code: "head-moved" });
    expect(git(cwd, ["rev-parse", "HEAD"])).toBe(moved);
  });

  it.each(["sha1", "sha256"])("creates an unborn %s branch with the zero old OID", async (objectFormat) => {
    const cwd = repo(format, objectFormat);
    const unborn = await captureGitHead(cwd);
    expect(unborn).toEqual({ branch: "refs/heads/main", oid: null });
    const commit = newCommit(cwd, "first\n");
    await expect(classifyGitPublication(cwd, unborn, commit, failed)).resolves.toBe("not-published");
    const tx = retain(await prepareGitRefUpdate(cwd, unborn, commit));
    expect(await tx.commit()).toEqual({ kind: "acknowledged" });
    expect(await captureGitHead(cwd)).toEqual({ branch: unborn.branch, oid: commit });
    await expect(prepareGitRefUpdate(cwd, unborn, commit)).rejects.toMatchObject({ code: "head-moved" });
  });

  it("holds HEAD and the branch against symbolic-ref and checkout during update and verify", async () => {
    const { cwd, base, commit } = startRepo(format);
    git(cwd, ["branch", "other", base]);
    const lock = await take(cwd);
    const original = await captureGitHead(cwd);
    for (const prepare of [
      () => prepareGitRefUpdate(cwd, original, commit),
      () => prepareGitRefVerify(cwd, original),
    ]) {
      const tx = retain(await prepare());
      expect(run(cwd, ["symbolic-ref", "HEAD", "refs/heads/other"]).status).not.toBe(0);
      expect(run(cwd, ["checkout", "-q", "other"]).status).not.toBe(0);
      expect(run(cwd, ["update-ref", original.branch, commit]).status).not.toBe(0);
      expect(await captureGitHead(cwd)).toEqual(original);
      await tx.abort();
    }
    await lock.release();
    git(cwd, ["checkout", "-q", "other"]);
    expect((await captureGitHead(cwd)).branch).toBe("refs/heads/other");
  });

  it("does not execute repository hooks during Git publication", async () => {
    const { cwd, base, commit } = startRepo(format);
    const hooks = join(cwd, "custom-hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "reference-transaction"), "#!/bin/sh\nprintf called > transaction-called\n", { mode: 0o755 });
    const monitor = join(hooks, "monitor");
    writeFileSync(monitor, "#!/bin/sh\nprintf called > monitor-called\n", { mode: 0o755 });
    git(cwd, ["config", "core.hooksPath", hooks]);
    git(cwd, ["config", "core.fsmonitor", monitor]);
    const lock = await take(cwd);
    const original = await captureGitHead(cwd);
    await retain(await prepareGitRefVerify(cwd, original)).abort();
    const receipt = await retain(await prepareGitRefUpdate(cwd, original, commit)).commit();
    expect(await classifyGitPublication(cwd, original, commit, receipt)).toBe("published");
    expect(await classifyGitPublication(cwd, original, commit, failed)).toBe("published");
    expect(existsSync(join(cwd, "transaction-called"))).toBe(false);
    expect(existsSync(join(cwd, "monitor-called"))).toBe(false);
    await lock.release();

    git(cwd, ["update-ref", "HEAD", base]);
    git(cwd, ["status", "--porcelain"]);
    expect(existsSync(join(cwd, "transaction-called"))).toBe(true);
    expect(existsSync(join(cwd, "monitor-called"))).toBe(true);
  });

  it("recovers published evidence from a branch descendant after an error receipt", async () => {
    const { cwd, commit } = startRepo(format);
    const original = await captureGitHead(cwd);
    expect(await retain(await prepareGitRefUpdate(cwd, original, commit)).commit()).toEqual({ kind: "acknowledged" });
    const descendant = newCommit(cwd, "external descendant\n", commit);
    git(cwd, ["update-ref", "HEAD", descendant, commit]);

    expect(await classifyGitPublication(cwd, original, commit, failed)).toBe("published");
    expect(await classifyGitPublication(cwd, original, commit)).toBe("published");
  });

  it("keeps the original index if publication fails before either branch or reflog changes", async () => {
    const { cwd, commit } = startRepo(format);
    const lock = await take(cwd);
    const before = readFileSync(lock.indexPath);
    const original = await captureGitHead(cwd);
    const tx = retain(await prepareGitRefUpdate(cwd, original, commit));
    await lock.write(preparedIndex(cwd, commit));
    await tx.abort();
    const evidence = await classifyGitPublication(cwd, original, commit, failed);
    expect(evidence).toBe("not-published");
    await expect(lock.install(evidence)).rejects.toThrow("Publication must be confirmed");
    await lock.release();
    expect(readFileSync(lock.indexPath)).toEqual(before);
    expect(readFileSync(join(cwd, "tracked.txt"), "utf8")).toBe("unsaved work\n");
  });

  it("treats a reflog entry written without a branch update as indeterminate", async () => {
    const { cwd, base, commit } = startRepo(format);
    const original = await captureGitHead(cwd);
    const lock = await take(cwd);
    const before = readFileSync(lock.indexPath);
    await lock.write(preparedIndex(cwd, commit));
    git(cwd, ["reflog", "write", original.branch, base, commit, "simulated ref update failure"]);
    expect(git(cwd, ["rev-parse", "HEAD"])).toBe(base);
    expect(git(cwd, ["reflog", "show", "--format=%H", original.branch]).split("\n")).toContain(commit);

    const evidence = await classifyGitPublication(cwd, original, commit, failed);
    expect(evidence).toBe("indeterminate");
    expect(await classifyGitPublication(cwd, original, commit)).toBe("indeterminate");
    await expect(lock.install(evidence)).rejects.toThrow("Publication must be confirmed");
    await lock.release();
    expect(readFileSync(lock.indexPath)).toEqual(before);
  });

  it("uses the exact commit acknowledgment even after an external soft reset", async () => {
    const { cwd, base, commit } = startRepo(format);
    const original = await captureGitHead(cwd);
    const lock = await take(cwd);
    const tx = retain(await prepareGitRefUpdate(cwd, original, commit));
    const bytes = preparedIndex(cwd, commit);
    await lock.write(bytes);
    const receipt = await tx.commit();
    expect(receipt).toEqual({ kind: "acknowledged" });
    git(cwd, ["reset", "--soft", "HEAD^"]);
    expect(git(cwd, ["rev-parse", "HEAD"])).toBe(base);
    expect(await classifyGitPublication(cwd, original, commit)).toBe("indeterminate");
    const evidence = await classifyGitPublication(cwd, original, commit, receipt);
    expect(evidence).toBe("published");
    await lock.install(evidence);
    expect(readFileSync(lock.indexPath)).toEqual(bytes);
    expect(git(cwd, ["diff", "--cached", "--name-only"])).toBe("tracked.txt");
    expect(git(cwd, ["show", ":tracked.txt"])).toBe("selected");
    expect(readFileSync(join(cwd, "tracked.txt"), "utf8")).toBe("unsaved work\n");
  });
});
