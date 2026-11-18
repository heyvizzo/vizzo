import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fixCommitIndex, recoverCommit, type CommitRecoveryCheckpoint, type CommitRecoveryJournal, type CommitRecoveryPorts,
} from "./commitRecovery.ts";
import { acquireIndexLock, captureGitHead, gitIndexPath, prepareGitRefVerify } from "./gitPublication.ts";
import { buildCommitTree, prepareIndexBytes } from "./gitTree.ts";

vi.setConfig({ testTimeout: 30_000 });
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function runGit(root: string, args: string[], indexPath?: string) {
  const result = spawnSync("git", [
    "-c", "user.name=Vizzo Test", "-c", "user.email=vizzo@example.invalid", "-c", "core.hooksPath=/dev/null", ...args,
  ], {
    cwd: root, timeout: 5_000, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_INDEX_FILE: indexPath },
  });
  if (result.error) throw result.error;
  return result;
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  expect(child.status).toBe(0);
  return child.pid;
}

async function fixture(format: "files" | "reftable", options: {
  objectFormat?: "sha1" | "sha256"; unborn?: boolean; deleted?: boolean;
} = {}) {
  const { objectFormat = "sha1", unborn = false, deleted = false } = options;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vizzo-recovery-")));
  directories.push(root);
  const git = (args: string[], index?: string) => {
    const result = runGit(root, args, index);
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} returned ${result.status}\n${result.stderr}`);
    return result.stdout.trimEnd();
  };
  git(["init", "-q", "--template=", "--initial-branch=main", `--ref-format=${format}`, `--object-format=${objectFormat}`]);
  const file = (path: string, contents: string) => writeFileSync(join(root, path), contents);
  if (!unborn) {
    for (const path of ["selected.txt", "assume.txt", "skip.txt", "staged\t\n.txt"]) file(path, "base\n");
    git(["add", "--", "."]);
    const base = git(["commit-tree", git(["write-tree"]), "-m", "Base"]);
    git(["update-ref", "HEAD", base]);
    git(["update-index", "--assume-unchanged", "assume.txt"]);
    git(["update-index", "--skip-worktree", "skip.txt"]);
  }
  file("selected.txt", "unstaged working copy\n");
  const head = await captureGitHead(root);
  const indexPath = await gitIndexPath(root);
  const lockPath = indexPath + ".lock";
  const project = { id: "project", root, commonDir: join(root, ".git") };
  const job = { project, request: { jobId: "job" }, pid: deadPid(), indexPath };
  const lock = await acquireIndexLock(indexPath, 0);
  try {
    const { commit, entries } = await buildCommitTree({
      root, indexPath, base: head.oid, message: "Selected work",
      entries: [deleted
        ? { path: "selected.txt", mode: "0", kind: "whole", content: null }
        : { path: "selected.txt", mode: "100644", kind: "whole", content: Buffer.from("selected commit\n") }],
    });
    const prepared = await prepareIndexBytes({ root, indexPath, entries });
    const candidate = { ...job, head, commit, entries, lock: lock.identity };
    async function orphan(bytes?: Buffer) {
      const orphan = await acquireIndexLock(indexPath, 0);
      try {
        if (bytes) await orphan.write(bytes);
        return { ...candidate, lock: orphan.identity };
      } finally { await orphan.close(); }
    }
    return {
      root, git, file, head, indexPath, lockPath, project, job, commit, entries, prepared, candidate, orphan,
      publish: () => git(["update-ref", "HEAD", commit]),
    };
  } finally { await lock.release(); }
}

function journalPorts<Job extends CommitRecoveryJournal>() {
  return {
    // Most cases pass the current journal directly. Shared-store tests override this lookup.
    reload: vi.fn<CommitRecoveryPorts<Job>["reload"]>().mockImplementation(async (job) => job as Job),
    checkpoint: vi.fn<CommitRecoveryPorts<Job>["checkpoint"]>().mockResolvedValue(undefined),
    finish: vi.fn<CommitRecoveryPorts<Job>["finish"]>().mockResolvedValue(undefined),
  };
}

const failedReceipt = { kind: "failed" as const, detail: "Lost transaction response" };

function interruptedPublish(root: string, base: string, commit: string): { pid: number; gitPid: number } {
  const script = String.raw`
    const { spawn } = require("node:child_process");
    const [base, commit] = process.argv.slice(1);
    const child = spawn("git", ["-c", "core.hooksPath=/dev/null", "update-ref", "--stdin"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let response = "";
    child.stdout.on("data", (data) => {
      response += data;
      if (!response.includes("prepare: ok\n")) return;
      child.kill("SIGSTOP");
      child.stdin.end("commit\n", () => {
        process.stdout.write(String(child.pid), () => process.exit(0));
      });
    });
    child.stdin.write("start\nupdate HEAD " + commit + " " + base + "\nprepare\n");
  `;
  const server = spawnSync(process.execPath, ["-e", script, base, commit], { cwd: root, encoding: "utf8", timeout: 10_000 });
  expect(server.status).toBe(0);
  const gitPid = Number(server.stdout);
  expect(gitPid).toBeGreaterThan(0);
  return { pid: server.pid, gitPid };
}

describe.each(["files", "reftable"] as const)("%s ref format", (format) => {
  it("refuses a locking job that never acquired its lock", async () => {
    const repo = await fixture(format);
    const journal = { ...repo.job, phase: "locking" as const, step: "acquire-index" };
    const ports = journalPorts<typeof journal>();
    const result = await recoverCommit(journal, ports);
    expect(result).toMatchObject({ status: "refused", evidence: "not-attempted", refusal: { code: "interrupted" } });
    expect(ports.checkpoint).not.toHaveBeenCalled();
    expect(ports.finish).toHaveBeenCalledWith(journal, result);
    expect(existsSync(repo.lockPath)).toBe(false);
  });

  it.each([{ phase: "locking" }, { phase: "publishing" }] as const)("durably cleans the owned lock before refusing $phase/cleanup", async (progress) => {
    const repo = await fixture(format);
    const abandoned = await repo.orphan();
    const journal = { ...abandoned, step: "cleanup" as const, refusal: { code: "test", reason: "Original refusal" }, ...progress };
    const ports = journalPorts<typeof journal>();
    const before = readFileSync(repo.indexPath);
    ports.checkpoint.mockImplementation(async (_job, state) => {
      expect(state).toMatchObject({ step: "cleanup", owner: { ...abandoned.lock, pid: abandoned.pid } });
      expect(existsSync(repo.lockPath)).toBe(true);
    });
    ports.finish.mockImplementation(async () => expect(existsSync(repo.lockPath)).toBe(false));
    expect(await recoverCommit(journal, ports)).toEqual({ status: "refused", evidence: "not-attempted", refusal: journal.refusal });
    expect(readFileSync(repo.indexPath)).toEqual(before);
  });

  it.each([
    { phase: "publishing", step: "prepare-ref" },
    { phase: "publishing", step: "prepare-index" },
    { phase: "publishing", step: "write-index" },
    { phase: "index-ready", step: "publish" },
    { phase: "index-ready", step: "classify" },
    { phase: "index-ready", step: "release" },
  ] as const)("classifies $phase/$step with an unchanged branch and no reflog entry", async (progress) => {
    const repo = await fixture(format);
    const abandoned = await repo.orphan(progress.phase === "index-ready" ? repo.prepared : undefined);
    const journal = { ...abandoned, ...progress, receipt: failedReceipt };
    const ports = journalPorts<typeof journal>();
    const before = readFileSync(repo.indexPath);
    expect(await recoverCommit(journal, ports)).toMatchObject({ status: "not-published", evidence: "not-published" });
    expect(existsSync(repo.lockPath)).toBe(false);
    expect(readFileSync(repo.indexPath)).toEqual(before);
  });

  it.each(["done", "refused", "not-published"] as const)("skips a settled %s job", async (phase) => {
    const repo = await fixture(format);
    const journal = { ...await repo.orphan(repo.prepared), phase };
    const ports = journalPorts<typeof journal>();
    expect(await recoverCommit(journal, ports)).toEqual({ status: "skipped", phase });
    expect(readFileSync(repo.lockPath)).toEqual(repo.prepared);
    expect(ports.checkpoint).not.toHaveBeenCalled();
    expect(ports.finish).not.toHaveBeenCalled();
  });

  it("installs a matching index-ready payload using the original lock inode", async () => {
    const repo = await fixture(format);
    const abandoned = await repo.orphan(repo.prepared);
    repo.publish();
    const journal = { ...abandoned, phase: "index-ready" as const, step: "install" as const, receipt: failedReceipt };
    const ports = journalPorts<typeof journal>();
    ports.checkpoint.mockImplementation(async (_job, state) => {
      expect(state).toMatchObject({ owner: { ...abandoned.lock, pid: process.pid }, reusable: true });
      if (state.step === "install-index") {
        expect(runGit(repo.root, ["symbolic-ref", "HEAD", "refs/heads/other"]).status).not.toBe(0);
        expect(runGit(repo.root, ["add", "selected.txt"]).status).not.toBe(0);
      }
    });
    const result = await recoverCommit(journal, ports);
    expect(result).toEqual({ status: "done", evidence: "published", commit: repo.commit, index: "reused" });
    expect(ports.checkpoint.mock.calls.map(([, state]) => state.step)).toEqual(["inspect-index", "install-index"]);
    expect(ports.finish).toHaveBeenCalledWith(journal, result);
    expect(readFileSync(repo.indexPath)).toEqual(repo.prepared);
    expect(readFileSync(join(repo.root, "selected.txt"), "utf8")).toBe("unstaged working copy\n");
    expect(repo.git(["ls-files", "-v", "assume.txt", "skip.txt"])).toBe("h assume.txt\nS skip.txt");
  });

  it.each([{ phase: "publishing" }, { phase: "indeterminate" }] as const)("rebuilds a published $phase job without a ready payload", async (progress) => {
    const repo = await fixture(format);
    const journal = { ...await repo.orphan(), ...progress };
    repo.publish();
    const ports = journalPorts<typeof journal>();
    expect(await recoverCommit(journal, ports)).toMatchObject({ status: "done", index: "rebuilt", evidence: "published" });
    expect(repo.git(["show", ":selected.txt"])).toBe("selected commit");
    expect(existsSync(repo.lockPath)).toBe(false);
  });

  it("repairs a published SHA-256 unborn job when no real index exists", async () => {
    const repo = await fixture(format, { objectFormat: "sha256", unborn: true });
    const journal = { ...repo.candidate, phase: "index-ready" as const, step: "repair" as const };
    repo.publish();
    expect(existsSync(repo.indexPath)).toBe(false);
    expect(await recoverCommit(journal, journalPorts())).toMatchObject({ status: "done", index: "rebuilt" });
    expect(repo.git(["show", ":selected.txt"])).toBe("selected commit");
  });

  it("recognizes a crash after installing the index and retries ledger settlement idempotently", async () => {
    const repo = await fixture(format);
    repo.publish();
    const journal = { ...repo.candidate, phase: "index-ready" as const, step: "install" as const };
    const ports = journalPorts<typeof journal>();
    ports.finish.mockRejectedValueOnce(new Error("Ledger write interrupted"));
    await expect(recoverCommit(journal, ports)).rejects.toThrow("Ledger write interrupted");
    const installed = readFileSync(repo.indexPath);
    expect(existsSync(repo.lockPath)).toBe(false);
    expect(await recoverCommit(journal, ports)).toMatchObject({ status: "done", index: "already-current" });
    const repairJournal = { ...journal, step: "repair" as const };
    expect(await fixCommitIndex(repairJournal, journalPorts())).toMatchObject({ status: "done", index: "already-current" });
    expect(readFileSync(repo.indexPath)).toEqual(installed);
  });

  it("repairs a published deletion with literal pathspecs enabled", async () => {
    const repo = await fixture(format, { deleted: true });
    const journal = { ...repo.candidate, phase: "index-ready" as const, step: "repair" as const };
    repo.publish();
    expect(repo.git(["show", ":selected.txt"])).toBe("base");
    vi.stubEnv("GIT_LITERAL_PATHSPECS", "1");
    try {
      expect(await recoverCommit(journal, journalPorts())).toMatchObject({ status: "done", index: "rebuilt" });
      expect(runGit(repo.root, ["show", ":selected.txt"]).status).not.toBe(0);
      expect(repo.git(["ls-files", "-v", "assume.txt", "skip.txt"])).toBe("h assume.txt\nS skip.txt");
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["fresh", "reopened", "replaced"] as const)("handles a failed install checkpoint with a %s index lock", async (kind) => {
    const repo = await fixture(format);
    const candidate = kind === "fresh" ? repo.candidate : await repo.orphan(repo.prepared);
    const journal = { ...candidate, phase: "index-ready" as const, step: "install" as const };
    let latest: typeof journal & { recovery?: CommitRecoveryCheckpoint } = journal;
    const before = readFileSync(repo.indexPath);
    repo.publish();
    const ports = journalPorts<typeof latest>();
    ports.reload.mockImplementation(async () => latest);
    let failCheckpoint = true;
    ports.checkpoint.mockImplementation(async (_job, state) => {
      if (state.step === "install-index" && failCheckpoint) {
        failCheckpoint = false;
        expect(latest.recovery).toMatchObject({ step: kind === "fresh" ? "write-index" : "inspect-index", owner: { pid: process.pid } });
        if (kind === "replaced") {
          renameSync(repo.lockPath, repo.lockPath + ".original");
          writeFileSync(repo.lockPath, "foreign lock");
        }
        throw new Error("Storage could not write the install checkpoint");
      }
      latest = { ...latest, recovery: state };
    });
    await expect(fixCommitIndex(journal, ports)).rejects.toThrow("Storage could not write the install checkpoint");
    expect(readFileSync(repo.indexPath)).toEqual(before);
    if (kind === "replaced") {
      expect(readFileSync(repo.lockPath, "utf8")).toBe("foreign lock");
      expect(await fixCommitIndex(journal, ports)).toMatchObject({ status: "blocked", reason: "index-locked" });
    } else {
      expect(existsSync(repo.lockPath)).toBe(false);
      expect(await fixCommitIndex(journal, ports)).toMatchObject({ status: "done", index: "rebuilt" });
      expect(repo.git(["show", ":selected.txt"])).toBe("selected commit");
    }
  });

  it("reloads the durable job after another queued Fix completes", async () => {
    const repo = await fixture(format);
    const journal = { ...repo.candidate, phase: "index-ready" as const, step: "repair" as const };
    let latest: CommitRecoveryJournal = journal;
    const ports = journalPorts<CommitRecoveryJournal>();
    ports.reload.mockImplementation(async () => latest);
    ports.finish.mockImplementation(async (_job, result) => {
      expect(result.status).toBe("done");
      latest = { ...journal, phase: "done" };
      repo.git(["reset", "--soft", repo.head.oid!]);
    });
    repo.publish();
    const first = fixCommitIndex(journal, ports);
    const second = fixCommitIndex(journal, ports);
    expect(await Promise.all([first, second])).toEqual(expect.arrayContaining([
      { status: "done", evidence: "published", commit: repo.commit, index: "rebuilt" },
      { status: "skipped", phase: "done" },
    ]));
    expect(ports.reload).toHaveBeenCalledTimes(2);
    expect(ports.finish).toHaveBeenCalledTimes(1);
    expect(repo.git(["rev-parse", "HEAD"])).toBe(repo.head.oid);
    expect(repo.git(["show", ":selected.txt"])).toBe("selected commit");
  });

  it("reopens a replacement recovery lock recorded before a second crash", async () => {
    const repo = await fixture(format);
    const abandoned = await repo.orphan(repo.prepared);
    repo.publish();
    const recovery: CommitRecoveryCheckpoint = { step: "install-index", owner: { ...abandoned.lock, pid: repo.job.pid }, reusable: true };
    const journal = { ...repo.candidate, phase: "publishing" as const, lock: { device: "0", inode: "0" }, recovery };
    expect(await recoverCommit(journal, journalPorts())).toMatchObject({ status: "done", index: "reused" });
    expect(readFileSync(repo.indexPath)).toEqual(repo.prepared);
  });

  it.each(["empty", "bad-checksum", "wrong-entry"] as const)("rebuilds an owned but %s index-ready payload", async (corruption) => {
    const repo = await fixture(format);
    // Keeping the base entries makes a valid checksum with semantically wrong contents.
    const bytes = corruption === "wrong-entry" ? readFileSync(repo.indexPath) : Buffer.from(repo.prepared);
    if (corruption === "bad-checksum") bytes[bytes.length - 1] = 0xff ^ bytes[bytes.length - 1]!;
    const journal = { ...await repo.orphan(corruption === "empty" ? undefined : bytes), phase: "index-ready" as const };
    repo.publish();
    expect(await recoverCommit(journal, journalPorts())).toMatchObject({ status: "done", index: "rebuilt" });
    const installed = readFileSync(repo.indexPath);
    expect(installed.subarray(-20)).toEqual(createHash("sha1").update(installed.subarray(0, -20)).digest());
    expect(repo.git(["show", ":selected.txt"])).toBe("selected commit");
  });

  it("rebuilds when the orphaned payload would overwrite different unrelated entries or flags", async () => {
    const repo = await fixture(format);
    const journal = { ...await repo.orphan(repo.prepared), phase: "index-ready" as const };
    // Model an external tool replacing the index while Vizzo was down, with the old lock restored separately.
    renameSync(repo.lockPath, repo.lockPath + ".saved");
    repo.file("staged\t\n.txt", "new user staging\n");
    repo.file("intent.txt", "unrelated intent to add\n");
    repo.git(["add", "--", "staged\t\n.txt"]);
    repo.git(["add", "-N", "intent.txt"]);
    repo.git(["update-index", "--no-assume-unchanged", "assume.txt"]);
    renameSync(repo.lockPath + ".saved", repo.lockPath);
    repo.publish();
    expect(await recoverCommit(journal, journalPorts())).toMatchObject({ status: "done", index: "rebuilt" });
    expect(repo.git(["show", ":staged\t\n.txt"])).toBe("new user staging");
    expect(repo.git(["ls-files", "--debug", "intent.txt"])).toContain("flags: 20004000");
    expect(repo.git(["ls-files", "-v", "assume.txt", "skip.txt"])).toBe("H assume.txt\nS skip.txt");
  });

  it("classifies an advanced branch as published without repairing the old index", async () => {
    const repo = await fixture(format);
    const journal = { ...await repo.orphan(repo.prepared), phase: "index-ready" as const };
    const before = readFileSync(repo.indexPath);
    repo.publish();
    const descendant = repo.git(["commit-tree", `${repo.commit}^{tree}`, "-p", repo.commit, "-m", "Descendant"]);
    repo.git(["update-ref", "HEAD", descendant]);
    expect(await recoverCommit(journal, journalPorts())).toMatchObject({
      status: "repair-needed", evidence: "published", reason: "branch-tip-changed", canFix: false,
    });
    expect(existsSync(repo.lockPath)).toBe(false);
    expect(readFileSync(repo.indexPath)).toEqual(before);
  });

  it.each(["the branch advances", "HEAD switches branches"] as const)("settles an installed index after %s", async (movement) => {
    const repo = await fixture(format);
    const journal = { ...await repo.orphan(repo.prepared), phase: "index-ready" as const, step: "install" as const };
    repo.publish();
    renameSync(repo.lockPath, repo.indexPath);
    const descendant = repo.git(["commit-tree", `${repo.commit}^{tree}`, "-p", repo.commit, "-m", "Descendant"]);
    const branch = movement === "the branch advances" ? repo.head.branch : "refs/heads/other";
    repo.git(["update-ref", branch, descendant]);
    if (branch !== repo.head.branch) repo.git(["symbolic-ref", "HEAD", branch]);
    const installed = readFileSync(repo.indexPath);
    const { ino, mtimeMs } = statSync(repo.indexPath);
    const ports = journalPorts<typeof journal>();

    const result = await recoverCommit(journal, ports);

    expect(result).toEqual({ status: "done", evidence: "published", commit: repo.commit, index: "already-current" });
    expect(ports.finish).toHaveBeenCalledWith(journal, result);
    expect(existsSync(repo.lockPath)).toBe(false);
    expect(readFileSync(repo.indexPath)).toEqual(installed);
    expect(statSync(repo.indexPath)).toMatchObject({ ino, mtimeMs });
    expect(repo.git(["symbolic-ref", "HEAD"])).toBe(branch);
    expect(repo.git(["rev-parse", "HEAD"])).toBe(descendant);
    expect(repo.git(["rev-parse", repo.head.branch])).toBe(branch === repo.head.branch ? descendant : repo.commit);
    expect(repo.git(["diff", "--cached", "--name-only"])).toBe("");
    expect(repo.git(["ls-files", "-v", "assume.txt", "skip.txt"])).toBe("h assume.txt\nS skip.txt");
  });

  it.each(["reflog only", "soft reset"] as const)("does not stage an unreachable commit after %s", async (source) => {
    const repo = await fixture(format);
    const journal = { ...await repo.orphan(repo.prepared), phase: "index-ready" as const, step: "install" as const,
      receipt: { kind: "acknowledged" as const } };
    const before = readFileSync(repo.indexPath);
    if (source === "reflog only") repo.git(["reflog", "write", repo.head.branch, repo.head.oid!, repo.commit, "Interrupted ref write"]);
    else {
      repo.publish();
      repo.git(["reset", "--soft", repo.head.oid!]);
    }
    expect(await recoverCommit(journal, journalPorts())).toMatchObject({ status: "indeterminate", evidence: "indeterminate" });
    expect(await fixCommitIndex(journal, journalPorts())).toMatchObject({ status: "indeterminate", evidence: "indeterminate" });
    expect(existsSync(repo.lockPath)).toBe(false);
    expect(readFileSync(repo.indexPath)).toEqual(before);
  });

  it("refuses repair when HEAD selects a different branch even at the same commit", async () => {
    const repo = await fixture(format);
    const journal = { ...await repo.orphan(repo.prepared), phase: "index-ready" as const };
    const before = readFileSync(repo.indexPath);
    repo.publish();
    repo.git(["update-ref", "refs/heads/other", repo.commit]);
    repo.git(["symbolic-ref", "HEAD", "refs/heads/other"]);
    expect(await recoverCommit(journal, journalPorts())).toMatchObject({
      status: "repair-needed", evidence: "published", reason: "branch-switched", canFix: false,
    });
    expect(readFileSync(repo.indexPath)).toEqual(before);
  });

  it("checks the selected paths under both locks after the user stages while Fix prepares", async () => {
    const repo = await fixture(format);
    repo.publish();
    const journal = { ...repo.candidate, phase: "index-ready" as const, step: "repair" as const, recovery: null };
    const ports = journalPorts<typeof journal>();
    let staged: Buffer | undefined;
    ports.checkpoint.mockImplementation(async (_job, state) => {
      if (state.step === "acquire-index") {
        repo.git(["add", "selected.txt"]);
        staged = readFileSync(repo.indexPath);
      }
    });
    expect(await fixCommitIndex(journal, ports)).toMatchObject({
      status: "repair-needed", evidence: "published", reason: "index-changed", canFix: false,
    });
    expect(staged).toBeDefined();
    expect(readFileSync(repo.indexPath)).toEqual(staged);
    expect(repo.git(["show", ":selected.txt"])).toBe("unstaged working copy");
    expect(existsSync(repo.lockPath)).toBe(false);
  });

  it("keeps flags added to a selected path after the crash", async () => {
    const repo = await fixture(format);
    repo.publish();
    repo.git(["update-index", "--assume-unchanged", "selected.txt"]);
    const journal = { ...repo.candidate, phase: "index-ready" as const, step: "repair" as const };
    const before = readFileSync(repo.indexPath);
    expect(await fixCommitIndex(journal, journalPorts())).toMatchObject({ status: "repair-needed", reason: "index-changed" });
    expect(readFileSync(repo.indexPath)).toEqual(before);
    expect(repo.git(["ls-files", "-v", "selected.txt"])).toBe("h selected.txt");
  });

  it("offers Fix after a foreign ref lock prevented repair", async () => {
    const repo = await fixture(format);
    repo.publish();
    const journal = { ...repo.candidate, phase: "index-ready" as const, step: "repair" as const };
    const ref = await prepareGitRefVerify(repo.root, { ...repo.head, oid: repo.commit });
    try {
      expect(await recoverCommit(journal, journalPorts())).toMatchObject({
        status: "blocked", evidence: "published", reason: "publication-busy", canFix: true,
      });
      expect(existsSync(repo.lockPath)).toBe(false);
    } finally { await ref.close(); }
    expect(await fixCommitIndex(journal, journalPorts())).toMatchObject({ status: "done", index: "rebuilt" });
  });

  it("preserves the orphan while the dead server's Git process still has a queued commit", async () => {
    const repo = await fixture(format);
    const abandoned = await repo.orphan(repo.prepared);
    const { pid, gitPid } = interruptedPublish(repo.root, repo.head.oid!, repo.commit);
    const journal = { ...abandoned, pid, phase: "index-ready" as const, step: "publish" as const };
    const ports = journalPorts<typeof journal>();
    const before = readFileSync(repo.indexPath);
    try {
      expect(() => process.kill(pid, 0)).toThrow();
      expect(repo.git(["rev-parse", "HEAD"])).toBe(repo.head.oid);
      expect(repo.git(["reflog", "show", "--format=%H", "HEAD"])).not.toContain(repo.commit);
      expect(await recoverCommit(journal, ports)).toMatchObject({
        status: "blocked", evidence: "unverified", reason: "publication-busy", canFix: true,
      });
      expect(ports.checkpoint).not.toHaveBeenCalled();
      expect(readFileSync(repo.lockPath)).toEqual(repo.prepared);
      expect(readFileSync(repo.indexPath)).toEqual(before);
    } finally { process.kill(gitPid, "SIGCONT"); }
    await expect.poll(() => repo.git(["rev-parse", "HEAD"]), { timeout: 8_000 }).toBe(repo.commit);
    // The original process can still hold its refs briefly after the new tip is observable.
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await fixCommitIndex(journal, ports);
      if (result.status === "blocked" && result.reason === "publication-busy") {
        await delay(25);
        continue;
      }
      expect(result).toMatchObject({ status: "done", evidence: "published", index: "reused" });
      expect(repo.git(["show", ":selected.txt"])).toBe("selected commit");
      return;
    }
    throw new Error("The resumed Git process did not release its ref locks");
  });

  it.each(["foreign identity", "live owner"] as const)("reports but preserves an index lock with %s", async (kind) => {
    const repo = await fixture(format);
    repo.publish();
    const abandoned = await repo.orphan(repo.prepared);
    const journal = kind === "live owner"
      ? { ...abandoned, phase: "index-ready" as const, pid: process.pid }
      : { ...abandoned, phase: "index-ready" as const, lock: { ...abandoned.lock, inode: "0" } };
    const ports = journalPorts<typeof journal>();
    const before = readFileSync(repo.indexPath);
    expect(await recoverCommit(journal, ports)).toMatchObject({
      status: "blocked", evidence: "published", reason: "index-locked",
      lock: { path: repo.lockPath, ...abandoned.lock, journaledPid: kind === "live owner" ? process.pid : undefined },
    });
    expect(ports.checkpoint).not.toHaveBeenCalled();
    expect(readFileSync(repo.lockPath)).toEqual(repo.prepared);
    expect(readFileSync(repo.indexPath)).toEqual(before);
  });

  it("repairs the linked worktree without changing the main worktree's index", async () => {
    const repo = await fixture(format);
    const linked = join(repo.root, "linked worktree");
    repo.git(["worktree", "add", "-q", "-b", "linked", linked]);
    const journal = {
      ...repo.candidate, phase: "index-ready" as const,
      project: { ...repo.project, root: linked }, indexPath: await gitIndexPath(linked), head: await captureGitHead(linked),
    };
    const before = readFileSync(repo.indexPath);
    // Updating the branch directly leaves the linked index at the captured base.
    repo.git(["update-ref", journal.head.branch, repo.commit]);
    expect(await recoverCommit(journal, journalPorts())).toMatchObject({ status: "done", index: "rebuilt" });
    expect(runGit(linked, ["show", ":selected.txt"]).stdout.trimEnd()).toBe("selected commit");
    expect(readFileSync(repo.indexPath)).toEqual(before);
  });

  it("blocks a journal for a different common directory or worktree index", async () => {
    const repo = await fixture(format);
    const abandoned = await repo.orphan(repo.prepared);
    const wrongDir = join(repo.root, "different-git-dir");
    mkdirSync(wrongDir);
    const journal = { ...abandoned, phase: "index-ready" as const };
    for (const mismatch of [
      { ...journal, project: { ...repo.project, commonDir: wrongDir } },
      { ...journal, indexPath: join(repo.root, "different-index") },
    ]) {
      expect(await recoverCommit(mismatch, journalPorts())).toMatchObject({
        status: "blocked", evidence: "unverified", reason: "repository-changed",
      });
      expect(readFileSync(repo.lockPath)).toEqual(repo.prepared);
    }
  });
});
