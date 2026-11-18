import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { ABSENT, type ReadEntry } from "./entries.ts";
import { MAX_FILE_BYTES, TOO_LARGE, exactText } from "./evidence.ts";

export interface LedgerProject {
  id: string;
  root: string;
  gitDir: string;
  commonDir: string;
  /** Spellings at dispatch and on disk. Multiple scope descriptors can share this project's state. */
  servedDir: string;
  scope: string;
}

export type ProjectDiscovery =
  | { project: LedgerProject; reason?: undefined }
  | { project?: undefined; reason: string };

export interface LedgerHead {
  branch: string | null;
  oid: string | null;
}

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const GIT_ENV = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_ATTR_SOURCE", "GIT_PREFIX",
];

function runGit(cwd: string, args: string[], maxBuffer = MAX_FILE_BYTES + 1) {
  const env = { ...process.env };
  for (const key of GIT_ENV) delete env[key];
  return spawnSync("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "--literal-pathspecs", ...args], { cwd, env, input: Buffer.alloc(0), maxBuffer });
}

function runProjectGit(project: LedgerProject, args: string[]) {
  return runGit(project.root, [`--git-dir=${project.gitDir}`, `--work-tree=${project.root}`, ...args]);
}

function utf8(bytes: Buffer): string {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("Git returned malformed UTF-8");
  return text;
}

function line(bytes: Buffer): string {
  const value = utf8(bytes);
  if (!value.endsWith("\n")) throw new Error("Unexpected Git output");
  return value.slice(0, -1);
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function folded(path: string): string {
  return path.normalize("NFC").toUpperCase().normalize("NFC");
}

function idFor(commonDir: string, root: string): string {
  return createHash("sha256").update(JSON.stringify([commonDir, root])).digest("hex");
}

function assertIdentity(project: LedgerProject): void {
  if (project.id !== idFor(project.commonDir, project.root) || !contains(project.root, project.scope) ||
      realpathSync(project.servedDir) !== project.scope || realpathSync(project.root) !== project.root ||
      realpathSync(project.gitDir) !== project.gitDir || realpathSync(project.commonDir) !== project.commonDir) {
    throw new Error("The pinned project folder or Git directory changed");
  }
  const dotGit = join(project.root, ".git");
  const gitMarker = lstatSync(dotGit);
  const gitDir = gitMarker.isDirectory() ? dotGit : readGitDirectoryMarker(dotGit, "gitdir: ");
  const commonMarker = join(project.gitDir, "commondir");
  const commonDir = lstatSync(commonMarker, { throwIfNoEntry: false }) ? readGitDirectoryMarker(commonMarker, "") : project.gitDir;
  if (realpathSync(gitDir) !== project.gitDir || realpathSync(commonDir) !== project.commonDir) {
    throw new Error("The worktree's Git metadata changed");
  }
  // Git reads can follow an index symlink. Refuse before running any command that may open the index.
  const index = lstatSync(join(project.gitDir, "index"), { throwIfNoEntry: false });
  if (index && !index.isFile()) throw new Error("The Git index is not a regular file");
}

function readGitDirectoryMarker(path: string, prefix: string): string {
  const file = lstatSync(path);
  if (!file.isFile() || file.size > 16_384) throw new Error("Unsupported Git directory marker");
  const text = utf8(readFileSync(path)).trimEnd();
  if (!text.startsWith(prefix) || text.length === prefix.length || text.includes("\0")) {
    throw new Error("Malformed Git directory marker");
  }
  return resolve(dirname(path), text.slice(prefix.length));
}

export function discoverLedgerProject(directory: string): ProjectDiscovery {
  try {
    if (!exactText(directory) || directory.includes("\0")) return { reason: "Malformed project directory" };
    const servedDir = resolve(directory);
    const scope = realpathSync(servedDir);
    const version = runGit(scope, ["--version"]);
    const [, major, minor] = /^git version (\d+)\.(\d+)/.exec(utf8(version.stdout ?? Buffer.alloc(0))) ?? [];
    if (version.status !== 0 || Number(major) < 2 || (Number(major) === 2 && Number(minor) < 41) || !major) {
      return { reason: "Source control requires Git 2.41 or later" };
    }
    const resolveGitPath = (flag: string): string => {
      const result = runGit(scope, ["rev-parse", "--path-format=absolute", flag]);
      if (result.status !== 0) throw new Error("The project folder is not in a Git worktree");
      return realpathSync(line(result.stdout));
    };
    const root = resolveGitPath("--show-toplevel");
    const gitDir = resolveGitPath("--absolute-git-dir");
    const commonDir = resolveGitPath("--git-common-dir");
    const project = { id: idFor(commonDir, root), root, gitDir, commonDir, servedDir, scope };
    assertIdentity(project);
    const empty = runGit(scope, ["hash-object", "-t", "tree", "--stdin"]);
    if (empty.status !== 0 || !OID.test(line(empty.stdout)) ||
        runGit(scope, [`--attr-source=${line(empty.stdout)}`, "hash-object", "--stdin"]).status !== 0) {
      return { reason: "This Git cannot read attributes from a selected tree" };
    }
    return { project };
  } catch (e) {
    return { reason: e instanceof Error ? e.message : String(e) };
  }
}

export function readLedgerHead(project: LedgerProject): LedgerHead {
  assertIdentity(project);
  // Read a branch's OID through its captured name so a concurrent checkout cannot pair another branch's OID with it.
  const symref = runProjectGit(project, ["symbolic-ref", "--quiet", "--no-recurse", "HEAD"]);
  if (symref.status !== 0 && symref.status !== 1) throw new Error("Could not read Git HEAD");
  const branch = symref.status === 0 ? line(symref.stdout) : null;
  const revision = runProjectGit(project, ["rev-parse", "--verify", "--quiet", branch ?? "HEAD"]);
  const oid = revision.status === 0 ? line(revision.stdout) : null;
  if ((revision.status !== 0 && revision.status !== 1) || (oid && !OID.test(oid)) || (!oid && !branch)) {
    throw new Error("Could not read the current Git revision");
  }
  return { branch, oid };
}

export function sameHead(a: LedgerHead, b: LedgerHead): boolean {
  return a.branch === b.branch && a.oid === b.oid;
}

/** Convert a reported absolute path to its exact worktree-relative spelling under the pinned scope. */
export function evidencePath(project: LedgerProject, path: string): string {
  if (!exactText(path) || path.includes("\0") || !isAbsolute(path) || normalize(path) !== path || path.endsWith(sep)) {
    throw new Error("Malformed edit path");
  }
  const served = contains(project.servedDir, path) ? project.servedDir : project.scope;
  if (!contains(served, path)) throw new Error("Edit path is outside the pinned project");
  const result = relative(project.root, join(project.scope, relative(served, path)));
  pathWithinProject(project, result);
  return result;
}

function pathWithinProject(project: LedgerProject, repoPath: string): string {
  if (!exactText(repoPath) || !repoPath || repoPath.includes("\0") || isAbsolute(repoPath) ||
      !repoPath.split(sep).every((part) => part && part !== "." && part !== ".." && folded(part) !== ".GIT")) {
    throw new Error("Malformed or Git metadata path");
  }
  const path = join(project.root, repoPath);
  if (path === project.scope || !contains(project.scope, path)) throw new Error("Path is outside the pinned project");
  for (const metadata of [project.gitDir, project.commonDir]) {
    if (contains(folded(metadata), folded(path)) || contains(folded(path), folded(metadata))) {
      throw new Error("Path reaches Git metadata");
    }
  }
  return path;
}

type PathStatus =
  | { kind: "absent" }
  | { kind: "file" | "symlink" | "alias"; path: string; stat: NonNullable<ReturnType<typeof lstatSync>> }
  | { kind: "opaque"; reason: string };

function pathStatus(project: LedgerProject, repoPath: string): PathStatus {
  pathWithinProject(project, repoPath);
  let directory = project.root;
  const names = repoPath.split(sep);
  for (const [index, name] of names.entries()) {
    const entry = join(directory, name);
    // Require the spelling actually present on disk. On a case-folding volume, both lstat calls
    // after a case-only rename would otherwise return the destination entry.
    const filename = Buffer.from(name);
    const exactName = readdirSync(directory, { encoding: "buffer" }).some((file) => {
      if (file.equals(filename)) return true;
      const text = file.toString("utf8");
      return text.normalize("NFC") === name.normalize("NFC") && Buffer.from(text).equals(file);
    });
    const stat = lstatSync(entry, { throwIfNoEntry: false });
    if (!stat) return ABSENT;
    if (!exactName) {
      if (index === names.length - 1) return { kind: "alias", path: entry, stat };
      return { kind: "opaque", reason: "Path has an aliased ancestor" };
    }
    if (index === names.length - 1) {
      if (stat.isSymbolicLink()) return { kind: "symlink", path: entry, stat };
      if (stat.isFile()) return { kind: "file", path: entry, stat };
      return { kind: "opaque", reason: "Not a regular file or symlink" };
    }
    if (!stat.isDirectory() || realpathSync(entry).normalize("NFC") !== entry.normalize("NFC")) {
      return { kind: "opaque", reason: "Path has a non-directory or symlink ancestor" };
    }
    if (lstatSync(join(entry, ".git"), { throwIfNoEntry: false })) return { kind: "opaque", reason: "Nested Git worktree" };
    directory = entry;
  }
  throw new Error("Missing project entry");
}

/** Check live entry and ancestors without recording working-tree bytes as tool evidence. */
export function pathAcceptsEvidence(project: LedgerProject, repoPath: string, caseSource?: string): boolean {
  assertIdentity(project);
  const status = pathStatus(project, repoPath);
  if (status.kind === "file") return status.stat.size <= MAX_FILE_BYTES;
  if (status.kind === "absent") return true;
  if (status.kind !== "alias" || caseSource === undefined || folded(caseSource) !== folded(repoPath) ||
      !status.stat.isFile() || status.stat.size > MAX_FILE_BYTES) return false;
  const other = pathStatus(project, caseSource);
  return other.kind === "file" && sameStat(status.stat, other.stat);
}

export function readWorkingEntry(project: LedgerProject, repoPath: string): ReadEntry {
  assertIdentity(project);
  const status = pathStatus(project, repoPath);
  if (status.kind === "absent" || status.kind === "opaque") return status;
  if (status.kind === "alias") return ABSENT;
  if (status.stat.size > MAX_FILE_BYTES) return { kind: "opaque", reason: TOO_LARGE };
  if (status.kind === "symlink") {
    const bytes = readlinkSync(status.path, { encoding: "buffer" });
    const after = pathStatus(project, repoPath);
    if (after.kind !== "symlink" || !sameStat(status.stat, after.stat)) {
      return { kind: "opaque", reason: "Symlink changed during read" };
    }
    return { kind: "symlink", bytes };
  }
  const fd = openSync(status.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    const located = pathStatus(project, repoPath);
    if (located.kind !== "file" || !sameStat(status.stat, before) || !sameStat(before, located.stat)) {
      return { kind: "opaque", reason: "File changed during read" };
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) return { kind: "opaque", reason: "File changed during read" };
      offset += count;
    }
    const after = pathStatus(project, repoPath);
    if (after.kind !== "file" || !sameStat(before, fstatSync(fd)) || !sameStat(before, after.stat)) {
      return { kind: "opaque", reason: "File changed during read" };
    }
    return { kind: "file", mode: before.mode & 0o100 ? "100755" : "100644", bytes };
  } finally {
    closeSync(fd);
  }
}

type Stat = NonNullable<ReturnType<typeof lstatSync>>;
function sameStat(a: Stat, b: Stat): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export function readBaseEntry(project: LedgerProject, repoPath: string, head: LedgerHead): ReadEntry {
  assertIdentity(project);
  pathWithinProject(project, repoPath);
  if (!head.oid) return ABSENT;
  if (!OID.test(head.oid)) throw new Error("Malformed Git revision");
  const ancestors: string[] = [];
  const parts = repoPath.split(sep);
  for (let depth = 1; depth <= parts.length; depth++) ancestors.push(parts.slice(0, depth).join(sep));
  const result = runProjectGit(project, ["ls-tree", "-z", head.oid, "--", ...ancestors]);
  if (result.status !== 0) throw new Error("Could not read the base tree");
  for (const row of utf8(result.stdout).split("\0").filter(Boolean)) {
    const match = /^(\d+) (blob|tree|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error("Unexpected base-tree entry");
    const [, mode, type, object, path] = match;
    if (!OID.test(object!)) throw new Error("Unexpected base-tree object");
    if (type === "commit") return { kind: "opaque", reason: "Submodule path" };
    if (path !== repoPath) {
      if (type === "blob") return { kind: "opaque", reason: "Base has a non-directory ancestor" };
      continue;
    }
    if (type !== "blob") return { kind: "opaque", reason: "Base has a directory at this path" };
    const size = runProjectGit(project, ["cat-file", "-s", object!]);
    if (size.status !== 0) throw new Error("Could not read the base blob size");
    if (Number(line(size.stdout)) > MAX_FILE_BYTES) return { kind: "opaque", reason: TOO_LARGE };
    const args = mode === "120000" ? ["cat-file", "blob", object!] :
      [`--attr-source=${head.oid}`, "cat-file", "--filters", `--path=${repoPath}`, object!];
    const blob = runProjectGit(project, args);
    if ((blob.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS" || blob.stdout?.length > MAX_FILE_BYTES) {
      return { kind: "opaque", reason: TOO_LARGE };
    }
    if (blob.status !== 0) throw new Error("Could not read the base blob");
    if (mode === "120000") return { kind: "symlink", bytes: blob.stdout };
    if (mode !== "100644" && mode !== "100755") return { kind: "opaque", reason: "Unsupported base entry mode" };
    return { kind: "file", mode, bytes: blob.stdout };
  }
  return ABSENT;
}
