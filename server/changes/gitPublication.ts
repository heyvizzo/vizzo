// Git's index and ref locks are separate. The caller keeps the index lock across
// ref publication and installs the prepared index only with publication evidence.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const INDEX_WAIT_MS = 2_000;
const INDEX_HEADER_SIZE = 12;
const INDEX_SIGNATURE = Buffer.from("DIRC");
const OID_BYTES = { sha1: 20, sha256: 32 };
const activeIndexLocks = new Set<string>();
const GIT_COMMAND_MS = 5_000;
const GIT_TEXT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const GIT_OPTIONS = [
  "--no-pager", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
  "-c", "advice.graftFileDeprecated=false",
];

export type PublicationEvidence = "published" | "not-published" | "indeterminate";

export class GitPublicationError extends Error {
  constructor(readonly code: "busy" | "index-layout" | "index-lock-lost" | "index-not-ready" | "head-layout" | "detached-head" | "head-moved" | "stale-context", message: string, cause?: unknown) {
    super(message, { cause });
  }
}

/** Stringified stat values preserve bigint precision in a JSON journal. */
export interface IndexLockIdentity {
  readonly device: string;
  readonly inode: string;
}

export interface JournaledIndexLock extends IndexLockIdentity {
  pid: number;
}

function fsError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function lockPath(indexPath: string): string {
  if (!isAbsolute(indexPath)) throw new Error("The Git index path must be absolute");
  return indexPath + ".lock";
}

function lockKey(identity: IndexLockIdentity): string {
  return identity.device + ":" + identity.inode;
}

function matchesLock(stat: BigIntStats, identity: IndexLockIdentity): boolean {
  return stat.isFile() && String(stat.dev) === identity.device && String(stat.ino) === identity.inode;
}

async function statPath(path: string): Promise<BigIntStats | null> {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if (fsError(error, "ENOENT")) return null;
    throw error;
  }
}

async function assertRegularIndex(path: string): Promise<void> {
  const stat = await statPath(path);
  // Git follows a symlink when determining where to take index.lock.
  if (stat && !stat.isFile()) {
    throw new GitPublicationError("index-layout", "Vizzo requires the Git index to be a regular file");
  }
}

function hasIndexHeader(bytes: Uint8Array): boolean {
  if (bytes.length < INDEX_HEADER_SIZE) return false;
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, INDEX_HEADER_SIZE);
  const version = header.readUInt32BE(4);
  return header.subarray(0, INDEX_SIGNATURE.length).equals(INDEX_SIGNATURE) && version >= 2 && version <= 4;
}

async function validRecoveredIndex(indexPath: string, file: FileHandle): Promise<boolean> {
  const { size } = await file.stat();
  if (size < INDEX_HEADER_SIZE + OID_BYTES.sha1) return false;
  const header = Buffer.alloc(INDEX_HEADER_SIZE);
  const headerRead = await file.read(header, 0, header.length, 0);
  if (headerRead.bytesRead !== header.length || !hasIndexHeader(header)) return false;

  const format = await objectFormat(dirname(indexPath), ["--git-dir=."]);
  const trailer = Buffer.alloc(OID_BYTES[format]);
  const contentSize = size - trailer.length;
  if (contentSize < INDEX_HEADER_SIZE) return false;
  const trailerRead = await file.read(trailer, 0, trailer.length, contentSize);
  if (trailerRead.bytesRead !== trailer.length) return false;

  // Git's normal index readers can accept a truncated or incorrect checksum.
  const hash = createHash(format);
  for await (const chunk of file.createReadStream({ start: 0, end: contentSize - 1, autoClose: false })) {
    hash.update(chunk);
  }
  return hash.digest().equals(trailer);
}

export class IndexLock {
  #closed = false;
  #prepared: "empty" | "recovered" | "staged";
  #pending: Promise<unknown> = Promise.resolve();

  constructor(readonly indexPath: string, readonly identity: IndexLockIdentity, private readonly file: FileHandle, recovered = false) {
    this.#prepared = recovered ? "recovered" : "empty";
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#pending.then(operation);
    this.#pending = pending.catch(() => {});
    return pending;
  }

  async #ownsPath(): Promise<boolean> {
    if (this.#closed) return false;
    const stat = await statPath(lockPath(this.indexPath));
    return stat !== null && matchesLock(stat, this.identity);
  }

  async #assertOwned(): Promise<void> {
    if (!(await this.#ownsPath())) {
      throw new GitPublicationError("index-lock-lost", "Vizzo's Git index lock is missing or has changed");
    }
  }

  /** Recheck the held lock after the caller's final checkpoint and before ref publication. */
  assertOwned(): Promise<void> {
    return this.#serialize(() => this.#assertOwned());
  }

  /** Write the prepared index without installing it. */
  write(bytes: Uint8Array): Promise<void> {
    return this.#serialize(async () => {
      await this.#assertOwned();
      this.#prepared = "empty";
      if (bytes.length < INDEX_HEADER_SIZE + OID_BYTES.sha1 || !hasIndexHeader(bytes)) {
        throw new GitPublicationError("index-not-ready", "The prepared Git index is incomplete");
      }
      for (let offset = 0; offset < bytes.length;) {
        const { bytesWritten } = await this.file.write(bytes, offset, bytes.length - offset, offset);
        if (!bytesWritten) throw new Error("Could not write the prepared Git index");
        offset += bytesWritten;
      }
      await this.file.truncate(bytes.length);
      await this.file.sync();
      this.#prepared = "staged";
    });
  }

  install(evidence: PublicationEvidence, assertContext?: () => void): Promise<void> {
    return this.#serialize(async () => {
      if (evidence !== "published") throw new Error("Publication must be confirmed before installing the Git index");
      await this.#assertOwned();
      if (this.#prepared === "empty" || (this.#prepared === "recovered" && !(await validRecoveredIndex(this.indexPath, this.file)))) {
        throw new GitPublicationError("index-not-ready", "The Git index lock does not hold a complete prepared index");
      }
      await assertRegularIndex(this.indexPath);
      await this.#assertOwned();
      assertContext?.();
      await rename(lockPath(this.indexPath), this.indexPath);
      await this.#closeHandle();
      const dir = await open(dirname(this.indexPath), "r");
      try { await dir.sync(); }
      finally { await dir.close(); }
    });
  }

  /** Delete this lock only while its identity still matches. */
  release(): Promise<boolean> {
    return this.#serialize(async () => {
      try {
        if (!(await this.#ownsPath())) return false;
        await unlink(lockPath(this.indexPath));
        return true;
      } finally { await this.#closeHandle(); }
    });
  }

  async #closeHandle(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { await this.file.close(); }
    finally { activeIndexLocks.delete(lockKey(this.identity)); }
  }

  /** Close the descriptor and preserve the file for a journal consumer. */
  close(): Promise<void> {
    return this.#serialize(() => this.#closeHandle());
  }
}

/** Resolve the current worktree's index, including when .git is a worktree pointer. */
export async function gitIndexPath(cwd: string): Promise<string> {
  const index = gitRecord(await readGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
  if (!isAbsolute(index)) throw new Error("Git did not report an absolute index path");
  return index;
}

export async function acquireIndexLock(indexPath: string, waitMs = INDEX_WAIT_MS): Promise<IndexLock> {
  const path = lockPath(indexPath);
  const budget = Number.isFinite(waitMs) ? Math.max(0, Math.min(waitMs, INDEX_WAIT_MS)) : INDEX_WAIT_MS;
  const deadline = performance.now() + budget;
  let file: FileHandle;
  for (;;) {
    try { file = await open(path, "wx+"); break; }
    catch (error) {
      if (!fsError(error, "EEXIST")) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new GitPublicationError("busy", "Git is busy");
      await delay(Math.min(50, remaining));
      if (performance.now() >= deadline) throw new GitPublicationError("busy", "Git is busy");
    }
  }
  let stat: BigIntStats;
  try { stat = await file.stat({ bigint: true }); }
  catch (error) { await file.close(); throw error; }
  const identity = { device: String(stat.dev), inode: String(stat.ino) };
  const key = lockKey(identity);
  if (activeIndexLocks.has(key)) {
    await file.close();
    throw new GitPublicationError("busy", "Git is busy");
  }
  activeIndexLocks.add(key);
  const lock = new IndexLock(indexPath, identity, file);
  try {
    await assertRegularIndex(indexPath);
    return lock;
  } catch (error) {
    await lock.release();
    throw error;
  }
}

/** Reopen a matching lock from a dead owner. The journal still decides whether its contents can be reused. */
export async function reopenIndexLock(indexPath: string, owner: JournaledIndexLock): Promise<IndexLock | null> {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return null;
  try { process.kill(owner.pid, 0); return null; }
  catch (error) { if (!fsError(error, "ESRCH")) return null; }

  const path = lockPath(indexPath);
  const key = lockKey(owner);
  if (activeIndexLocks.has(key)) return null;
  activeIndexLocks.add(key);
  let file: FileHandle | undefined;
  let reopened = false;
  try {
    const stat = await statPath(path);
    if (!stat || !matchesLock(stat, owner)) return null;
    file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!matchesLock(await file.stat({ bigint: true }), owner)) return null;
    const current = await statPath(path);
    if (!current || !matchesLock(current, owner)) return null;
    reopened = true;
    return new IndexLock(indexPath, { device: owner.device, inode: owner.inode }, file, true);
  } catch (error) {
    if (fsError(error, "ENOENT") || fsError(error, "ELOOP")) return null;
    throw error;
  } finally {
    if (!reopened) {
      try { await file?.close(); }
      finally { activeIndexLocks.delete(key); }
    }
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_NAMESPACE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_QUARANTINE_PATH: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_SHALLOW_FILE: undefined,
    GIT_GRAFT_FILE: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
  };
}

function git(cwd: string, args: string[]): Promise<{ code: number | null; stdout: Buffer; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    execFile("git", [...GIT_OPTIONS, ...args], { cwd, env: gitEnv(), timeout: GIT_COMMAND_MS, maxBuffer: 8 << 20, encoding: "buffer" }, (error, stdout, stderr) => {
      const code = !error ? 0 : typeof error.code === "number" ? error.code : null;
      resolve({ code, stdout, stderr: stderr.toString("utf8"), error: error?.message });
    });
  });
}

async function readGit(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.code !== 0 || result.stderr) throw new Error(result.stderr || result.error || "Git could not read publication evidence");
  return GIT_TEXT.decode(result.stdout);
}

function gitRecord(output: string): string {
  if (!output.endsWith("\n")) throw new Error("Git returned an incomplete record");
  return output.slice(0, -1);
}

export interface GitHead {
  branch: string;
  oid: string | null;
}

function isOid(value: string): boolean {
  return (value.length === 40 || value.length === 64) && !/[^0-9a-f]/.test(value) && /[1-9a-f]/.test(value);
}

async function isBranch(cwd: string, branch: string): Promise<boolean> {
  return branch.startsWith("refs/heads/") && (await git(cwd, ["check-ref-format", branch])).code === 0;
}

async function directHeadBranch(cwd: string): Promise<string> {
  const direct = await git(cwd, ["symbolic-ref", "--quiet", "--no-recurse", "HEAD"]);
  if (direct.code === 1 && !direct.stderr) throw new GitPublicationError("detached-head", "HEAD is detached");
  try {
    if (direct.code !== 0 || direct.stderr) throw new Error(direct.stderr || direct.error);
    const branch = gitRecord(GIT_TEXT.decode(direct.stdout));
    if (await isBranch(cwd, branch) && await readGit(cwd, ["symbolic-ref", "--quiet", "HEAD"]) === branch + "\n") {
      return branch;
    }
  } catch (error) {
    throw new GitPublicationError("head-layout", "HEAD must point directly to a Git branch with a valid UTF-8 name", error);
  }
  throw new GitPublicationError("head-layout", "HEAD must point directly to a Git branch");
}

async function branchTip(cwd: string, branch: string): Promise<string | null> {
  const refs = await readGit(cwd, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", "--", branch]);
  for (const line of refs.split("\n")) {
    const [name, oid, symbolic] = line.split("\0");
    if (name !== branch) continue;
    if (symbolic !== "" || oid === undefined || !isOid(oid)) throw new Error("Git branch has an unsupported reference");
    return oid;
  }
  return null;
}

export async function captureGitHead(cwd: string): Promise<GitHead> {
  const branch = await directHeadBranch(cwd);
  return { branch, oid: await branchTip(cwd, branch) };
}

async function objectFormat(cwd: string, options: string[] = []): Promise<keyof typeof OID_BYTES> {
  const format = gitRecord(await readGit(cwd, [...options, "rev-parse", "--show-object-format"]));
  if (format === "sha1" || format === "sha256") return format;
  throw new Error("Unsupported Git object format");
}

async function oldOid(cwd: string, head: GitHead): Promise<string> {
  if (head.oid !== null) {
    if (!isOid(head.oid)) throw new Error("Invalid base commit OID");
    return head.oid;
  }
  const format = await objectFormat(cwd);
  return "0".repeat(OID_BYTES[format] * 2);
}

export type RefCommitResult = { kind: "acknowledged" } | { kind: "failed"; detail: string };

export interface PreparedGitRefVerification {
  abort(): Promise<void>;
  close(): Promise<void>;
}

export interface PreparedGitRefUpdate extends PreparedGitRefVerification {
  commit(): Promise<RefCommitResult>;
}

class RefProcess {
  #child: ChildProcessWithoutNullStreams;
  #exited: Promise<void>;
  #closed = false;
  #stdout = "";
  #receive?: (line: string | null) => void;
  detail = "";

  constructor(cwd: string) {
    this.#child = spawn("git", [...GIT_OPTIONS, "update-ref", "--stdin"], { cwd, env: gitEnv() });
    this.#child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      this.#stdout += chunk;
      const newline = this.#stdout.indexOf("\n");
      if (newline >= 0) {
        this.#receive?.(this.#stdout.slice(0, newline));
        this.#stdout = this.#stdout.slice(newline + 1);
      }
    });
    this.#child.stderr.setEncoding("utf8").on("data", (chunk: string) => { this.detail = (this.detail + chunk).slice(0, 8_192); });
    this.#child.on("error", (error) => { this.detail ||= error.message; });
    this.#child.stdin.on("error", (error) => { this.detail ||= error.message; });
    this.#exited = new Promise<void>((resolve) => {
      this.#child.once("close", (code, signal) => {
        this.#closed = true;
        this.detail ||= signal ? `git update-ref exited on ${signal}` : `git update-ref exited with code ${code}`;
        this.#receive?.(null);
        resolve();
      });
    });
  }

  async expect(input: string, reply: string, final = false): Promise<boolean> {
    if (this.#closed) return false;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.detail ||= "git update-ref did not respond";
        this.#child.kill();
      }, GIT_COMMAND_MS);
      this.#receive = (line) => {
        clearTimeout(timeout);
        this.#receive = undefined;
        resolve(line === reply);
      };
      if (final) this.#child.stdin.end(input);
      else this.#child.stdin.write(input);
    });
  }

  async close(): Promise<void> {
    this.#child.stdin.end();
    await this.#exited;
  }
}

async function prepareRef(cwd: string, head: GitHead, command: string): Promise<PreparedGitRefUpdate> {
  const git = new RefProcess(cwd);
  let prepared = false;
  try {
    if (!(await git.expect("start\n", "start: ok"))) throw new Error(git.detail);
    prepared = await git.expect(command + "\nprepare\n", "prepare: ok");
    if (!prepared) throw new Error(git.detail);
    if (await directHeadBranch(cwd) !== head.branch) throw new Error("HEAD points to a different branch");
  } catch (error) {
    if (prepared) await git.expect("abort\n", "abort: ok", true);
    await git.close();
    throw new GitPublicationError("head-moved", "HEAD moved: review again", error);
  }

  let result: Promise<RefCommitResult> | undefined;
  async function finish(action: "commit" | "abort"): Promise<RefCommitResult> {
    if (result) throw new Error("The Git ref transaction has already finished");
    result = (async () => {
      const acknowledged = await git.expect(action + "\n", action + ": ok", true);
      await git.close();
      return acknowledged ? { kind: "acknowledged" } : { kind: "failed", detail: git.detail.trimEnd() };
    })();
    return result;
  }
  async function abort(): Promise<void> {
    if (result) { await result; return; }
    await finish("abort");
  }
  return { commit: () => finish("commit"), abort, close: abort };
}

export async function prepareGitRefUpdate(cwd: string, head: GitHead, commit: string): Promise<PreparedGitRefUpdate> {
  const expected = await oldOid(cwd, head);
  if (!isOid(commit) || commit.length !== expected.length) throw new Error("Invalid publication commit OID");
  return prepareRef(cwd, head, `update HEAD ${commit} ${expected}`);
}

export async function prepareGitRefVerify(cwd: string, head: GitHead): Promise<PreparedGitRefVerification> {
  const expected = await oldOid(cwd, head);
  const { abort, close } = await prepareRef(cwd, head, `verify HEAD ${expected}`);
  return { abort, close };
}

async function reflogContains(cwd: string, ref: string, commit: string): Promise<boolean> {
  const exists = await git(cwd, ["reflog", "exists", ref]);
  if (exists.code === 1 && !exists.stdout.length && !exists.stderr) return false;
  if (exists.code !== 0 || exists.stderr) throw new Error("Git could not read the reflog");
  const log = await readGit(cwd, ["reflog", "show", "--no-notes", "--no-show-signature", "--format=%H", ref, "--"]);
  return log.split("\n").includes(commit);
}

/** A missing receipt means startup recovery. A reflog entry alone cannot confirm publication. */
export async function classifyGitPublication(cwd: string, base: GitHead, commit: string, receipt?: RefCommitResult): Promise<PublicationEvidence> {
  if (receipt?.kind === "acknowledged") return "published";
  try {
    if (!isOid(commit) || !(await isBranch(cwd, base.branch))) return "indeterminate";
    const tip = await branchTip(cwd, base.branch);
    if (tip === commit) return "published";
    if (tip !== null) {
      const reachable = await git(cwd, ["merge-base", "--is-ancestor", commit, tip]);
      if (reachable.code === 0 && !reachable.stderr) return "published";
      if (reachable.code !== 1 || reachable.stderr) return "indeterminate";
    }
    if (tip !== base.oid) return "indeterminate";
    const reflogs = await Promise.all([
      reflogContains(cwd, base.branch, commit),
      reflogContains(cwd, "HEAD", commit),
    ]);
    if (reflogs.some(Boolean)) return "indeterminate";
    if (await branchTip(cwd, base.branch) === tip) return "not-published";
  } catch { /* Unreadable evidence cannot establish either outcome. */ }
  return "indeterminate";
}
