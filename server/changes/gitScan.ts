import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, readlink, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export const GIT_SCAN_MAX_FILE_BYTES = 5_000_000;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const TOO_LARGE = "Too large for Vizzo to track";
const SUBMODULE = "Submodule changes cannot be committed by Vizzo";
const UNREADABLE = "The working entry could not be read safely";
const CHANGED = "The working entry changed while it was being read";

// Darwin fcntl.h. Unlike O_NOFOLLOW, this also rejects symlinks in intermediate components.
const DARWIN_NOFOLLOW_ANY = 0x20000000;
const DARWIN_OPEN_SYMLINK = 0x00200000;

const ATTRIBUTES = ["filter", "ident", "working-tree-encoding", "diff"] as const;
type Attribute = typeof ATTRIBUTES[number];

export interface GitScanScope {
  worktreeRoot: string;
  projectDir: string;
}

export interface GitScanHead {
  branch: string | null;
  oid: string | null;
}

export class GitScanBaseChangedError extends Error {
  constructor() {
    super("HEAD moved: review again");
    this.name = "GitScanBaseChangedError";
  }
}

export interface GitScanStatus {
  kind: "ordinary" | "rename" | "unmerged" | "untracked" | "ignored";
  xy: string | null;
  submodule: string | null;
  /** In order: HEAD/index/worktree, or stages 1–3/worktree for an unmerged record. */
  modes: string[];
  /** In order: HEAD/index, or stages 1–3 for an unmerged record. */
  oids: string[];
  score: string | null;
  pathBytes: Buffer;
  originalPathBytes: Buffer | null;
  /** The primary porcelain record, without its NUL terminator. The original rename path is separate. */
  raw: Buffer;
}

type GitAttributes = Record<Attribute, Buffer | null>;
type FileMode = "100644" | "100755" | "120000";

export interface GitScanBaseEntry {
  mode: string;
  oid: string;
  raw: Buffer | null;
  working: Buffer | null;
  workingSha256: string | null;
}

export interface GitScanWorkingEntry {
  mode: FileMode;
  bytes: Buffer;
  sha256: string;
}

export interface GitScanEntry {
  /** Repository-relative with Git's spelling. Null when the filename cannot be used safely as a string. */
  path: string | null;
  projectPath: string | null;
  pathBytes: Buffer;
  status: GitScanStatus[];
  base: GitScanBaseEntry | null;
  current: GitScanWorkingEntry | null;
  attributes: { base: GitAttributes | null; current: GitAttributes | null };
  conversion: "identity" | "whole";
  wholeEntryReason: "conversion" | "binary" | "symlink" | "rename" | "gitattributes" | "unavailable" | null;
  /** When set, the evidence is insufficient for normal ownership or selection. */
  otherReason: string | null;
}

export interface GitScanResult {
  entries: GitScanEntry[];
}

interface ScopedProject {
  root: string;
  dir: string;
  prefix: Buffer;
  pathspec: string[];
}

interface Candidate {
  path: string | null;
  projectPath: string | null;
  pathBytes: Buffer;
  status: GitScanStatus[];
  directory: boolean;
}

interface TreeEntry {
  mode: string;
  oid: string;
}

interface GitOptions {
  input?: Buffer;
  cap?: number;
  accept?: number[];
}

class GitOutputLimitError extends Error {}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Use the discovered worktree and its own index, including in a linked worktree or a Git-launched shell.
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_ATTR_SOURCE", "GIT_COMMON_DIR", "GIT_CONFIG",
    "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_GRAFT_FILE", "GIT_IMPLICIT_WORK_TREE",
    "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX", "GIT_REPLACE_REF_BASE", "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE", "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS",
  ]) delete env[key];
  // Trace destinations can be files. Explicitly override Trace2 destinations from Git config too.
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_TRACE")) delete env[key];
  }
  env.GIT_TRACE2 = env.GIT_TRACE2_EVENT = env.GIT_TRACE2_PERF = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.LC_ALL = "C";
  return env;
}

function git(root: string, args: string[], { input, cap = MAX_METADATA_BYTES, accept = [] }: GitOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", [
      "--no-pager", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
      "-C", root, ...args,
    ], { encoding: "buffer", env: gitEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: cap }, (error, stdout) => {
      if (!error || (typeof error.code === "number" && accept.includes(error.code))) return resolve(stdout);
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        return reject(new GitOutputLimitError("Git output exceeded Vizzo's read limit"));
      }
      reject(error);
    });
    // If the command rejects its arguments and exits before consuming stdin, use its exit status.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodePath(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    const path = utf8.decode(bytes);
    const parts = path.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) return null;
    if (sep === "\\" && /[:\\]/.test(path)) return null;
    return path;
  } catch {
    return null;
  }
}

function key(bytes: Buffer): string {
  return bytes.toString("hex");
}

function splitNul(bytes: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(0, start);
    if (end === -1) throw new Error("Git returned an unterminated NUL record");
    fields.push(bytes.subarray(start, end));
    start = end + 1;
  }
  return fields;
}

function splitPrefix(record: Buffer, count: number): { metadata: string[]; pathBytes: Buffer } {
  const metadata: string[] = [];
  let start = 0;
  for (let i = 0; i < count; i++) {
    const end = record.indexOf(0x20, start);
    if (end < start) throw new Error("Git returned incomplete status metadata");
    metadata.push(record.toString("ascii", start, end));
    start = end + 1;
  }
  return { metadata, pathBytes: record.subarray(start) };
}

function parseStatus(bytes: Buffer): { branch: Buffer; oid: string | null; entries: GitScanStatus[] } {
  const entries: GitScanStatus[] = [];
  let branch: Buffer | null = null;
  let oid: string | undefined;
  const records = splitNul(bytes);
  for (let i = 0; i < records.length; i++) {
    const raw = records[i]!;
    const code = raw[0];
    if (code === 0x23) { // #
      const header = raw.subarray(0, 13).toString("ascii");
      if (header === "# branch.oid ") oid = raw.subarray(13).toString("ascii");
      if (raw.subarray(0, 14).toString("ascii") === "# branch.head ") branch = raw.subarray(14);
      continue;
    }
    if (code === 0x3f || code === 0x21) { // ? and !
      entries.push({
        kind: code === 0x3f ? "untracked" : "ignored", xy: null, submodule: null, modes: [], oids: [],
        score: null, pathBytes: raw.subarray(2), originalPathBytes: null, raw,
      });
      continue;
    }
    const kind = code === 0x31 ? "ordinary" : code === 0x32 ? "rename" : code === 0x75 ? "unmerged" : null;
    if (!kind) throw new Error("Git returned an unknown porcelain status record");
    const unmerged = kind === "unmerged";
    const { metadata, pathBytes } = splitPrefix(raw, unmerged ? 10 : kind === "rename" ? 9 : 8);
    const originalPathBytes = kind === "rename" ? records[++i] ?? null : null;
    if (kind === "rename" && !originalPathBytes) throw new Error("Git returned a rename without its original path");
    entries.push({
      kind, xy: metadata[1]!, submodule: metadata[2]!, modes: metadata.slice(3, unmerged ? 7 : 6),
      oids: unmerged ? metadata.slice(7, 10) : metadata.slice(6, 8), score: kind === "rename" ? metadata[8]! : null,
      pathBytes, originalPathBytes, raw,
    });
  }
  if (oid === undefined || branch === null) throw new Error("Git status did not report HEAD");
  return { branch, oid: oid === "(initial)" ? null : oid, entries };
}

async function resolveScope(scope: GitScanScope): Promise<ScopedProject> {
  const [root, dir] = await Promise.all([realpath(scope.worktreeRoot), realpath(scope.projectDir)]);
  const folder = relative(root, dir);
  if (isAbsolute(folder) || folder === ".." || folder.startsWith(".." + sep)) {
    throw new Error("The project folder is outside its Git worktree");
  }
  if (!folder) return { root, dir, prefix: Buffer.alloc(0), pathspec: [] };
  const physicalFolder = folder.split(sep).join("/");
  // Git may precompose directory names on macOS. Use its spelling, and remove only its final newline.
  const output = await git(dir, ["rev-parse", "--show-prefix"]);
  const prefix = output.subarray(0, -1);
  const gitFolder = decodePath(prefix.subarray(0, -1));
  if (output.at(-1) !== 0x0a || prefix.at(-1) !== 0x2f || gitFolder === null
      || (gitFolder !== physicalFolder && !(process.platform === "darwin" && gitFolder.normalize() === physicalFolder.normalize()))) {
    throw new Error("Unsupported Git project folder");
  }
  return { root, dir, prefix, pathspec: [`:(top,literal)${gitFolder}`] };
}

function statusMatchesHead(status: ReturnType<typeof parseStatus>, head: GitScanHead): boolean {
  const branch = head.branch?.slice("refs/heads/".length) ?? "(detached)";
  return status.oid === head.oid && status.branch.equals(Buffer.from(branch));
}

function gitRecord(bytes: Buffer): string | null {
  if (!bytes.length) return null;
  if (bytes.at(-1) !== 0x0a) throw new Error("Git returned an unterminated record");
  return utf8.decode(bytes.subarray(0, -1));
}

async function verifyHead(root: string, head: GitScanHead): Promise<void> {
  const [branch, oid] = await Promise.all([
    git(root, ["symbolic-ref", "--quiet", "--no-recurse", "HEAD"], { accept: [1] }),
    git(root, ["rev-parse", "--quiet", "--verify", "HEAD"], { accept: [1] }),
  ]);
  if (gitRecord(branch) !== head.branch || gitRecord(oid) !== head.oid) {
    throw new GitScanBaseChangedError();
  }
}

function inProject(bytes: Buffer, scope: ScopedProject): boolean {
  return bytes.length > scope.prefix.length && bytes.subarray(0, scope.prefix.length).equals(scope.prefix);
}

function candidates(
  scope: ScopedProject, statuses: GitScanStatus[], additionalPaths: readonly string[],
): Map<string, Candidate> {
  const result = new Map<string, Candidate>();
  const add = (rawPath: Buffer, status?: GitScanStatus): void => {
    const directory = rawPath.at(-1) === 0x2f;
    const bytes = directory ? rawPath.subarray(0, -1) : rawPath;
    if (!inProject(bytes, scope)) return;
    const id = key(bytes);
    const existing = result.get(id);
    if (existing) {
      if (status && !existing.status.includes(status)) existing.status.push(status);
      existing.directory ||= directory;
      return;
    }
    const path = decodePath(bytes);
    result.set(id, {
      path, projectPath: path === null ? null : decodePath(bytes.subarray(scope.prefix.length)),
      pathBytes: bytes, status: status ? [status] : [], directory,
    });
  };
  for (const status of statuses) {
    add(status.pathBytes, status);
    if (status.originalPathBytes) add(status.originalPathBytes, status);
  }
  for (const path of additionalPaths) {
    const bytes = Buffer.from(path);
    if (decodePath(bytes) !== path || !inProject(bytes, scope)) throw new Error("Additional Git path is outside the project or unsupported");
    add(bytes);
  }
  return result;
}

async function readBaseTree(scope: ScopedProject, oid: string | null): Promise<Map<string, TreeEntry>> {
  const tree = new Map<string, TreeEntry>();
  if (!oid) return tree;
  const output = await git(scope.root, ["ls-tree", "-r", "-z", "--full-tree", oid, "--", ...scope.pathspec]);
  for (const record of splitNul(output)) {
    const tab = record.indexOf(0x09);
    if (tab === -1) throw new Error("Git returned an invalid tree entry");
    const [mode, , object] = record.toString("ascii", 0, tab).split(" ");
    const path = record.subarray(tab + 1);
    if (!mode || !object || !inProject(path, scope)) continue;
    tree.set(key(path), { mode, oid: object });
  }
  return tree;
}

function submodulePaths(base: Map<string, TreeEntry>, paths: Map<string, Candidate>): Set<string> {
  const submodules = new Set<string>();
  for (const [id, entry] of base) {
    if (entry.mode === "160000") submodules.add(id);
  }
  for (const [id, path] of paths) {
    if (path.status.some((status) => status.submodule?.startsWith("S") || status.modes.includes("160000"))) submodules.add(id);
  }
  return submodules;
}

function insideSubmodule(path: Buffer, submodules: Set<string>): boolean {
  let end = path.indexOf(0x2f);
  while (end !== -1) {
    if (submodules.has(key(path.subarray(0, end)))) return true;
    end = path.indexOf(0x2f, end + 1);
  }
  return submodules.has(key(path));
}

function nulPaths(paths: Candidate[], prefix = Buffer.alloc(0)): Buffer {
  const separator = Buffer.from([0]);
  return Buffer.concat(paths.flatMap((path) => [prefix, path.pathBytes, separator]));
}

async function ignoredPaths(root: string, candidates: Candidate[]): Promise<Set<string>> {
  const ignored = new Set<string>();
  if (!candidates.length) return ignored;
  // check-ignore rejects literal pathspec magic. A ./ prefix protects names beginning with a colon.
  const prefix = Buffer.from("./");
  const output = await git(root, ["check-ignore", "--stdin", "-z", "--verbose"], {
    input: nulPaths(candidates, prefix), accept: [1],
  });
  const fields = splitNul(output);
  if (fields.length % 4) throw new Error("Git returned incomplete ignore metadata");
  for (let i = 0; i < fields.length; i += 4) {
    if (fields[i + 2]![0] !== 0x21) ignored.add(key(fields[i + 3]!.subarray(prefix.length)));
  }
  return ignored;
}

function noAttributes(): GitAttributes {
  return { filter: null, ident: null, "working-tree-encoding": null, diff: null };
}

async function readAttributes(root: string, candidates: Candidate[], oid?: string): Promise<Map<string, GitAttributes>> {
  const attributes = new Map(candidates.map((path) => [key(path.pathBytes), noAttributes()]));
  if (!candidates.length) return attributes;
  // --all distinguishes a missing attribute from an explicit string value of "unspecified".
  const args = ["check-attr", ...(oid ? [`--source=${oid}`] : []), "--all", "--stdin", "-z"];
  const triples = splitNul(await git(root, args, { input: nulPaths(candidates) }));
  if (triples.length % 3) throw new Error("Git returned incomplete attribute metadata");
  for (let i = 0; i < triples.length; i += 3) {
    const attrs = attributes.get(key(triples[i]!));
    const attr = ATTRIBUTES.find((name) => triples[i + 1]!.equals(Buffer.from(name)));
    if (attrs && attr) attrs[attr] = triples[i + 2]!;
  }
  return attributes;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBase(
  root: string, base: GitScanHead, path: string, tree: TreeEntry | undefined,
): Promise<{ entry: GitScanBaseEntry | null; reason: string | null }> {
  if (!tree) return { entry: null, reason: null };
  const entry: GitScanBaseEntry = { ...tree, raw: null, working: null, workingSha256: null };
  try {
    const size = Number((await git(root, ["cat-file", "-s", tree.oid])).toString("ascii").trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Unexpected Git blob size");
    if (size > GIT_SCAN_MAX_FILE_BYTES) return { entry, reason: TOO_LARGE };
    entry.raw = await git(root, ["cat-file", "blob", tree.oid], { cap: GIT_SCAN_MAX_FILE_BYTES });
    if (entry.raw.length !== size) throw new Error("Unexpected Git blob length");
    entry.working = tree.mode === "120000" ? entry.raw : await git(root, [
      `--attr-source=${base.oid}`, "cat-file", "--filters", `--path=${path}`, tree.oid,
    ], { cap: GIT_SCAN_MAX_FILE_BYTES });
    entry.workingSha256 = sha256(entry.working);
    return { entry, reason: null };
  } catch (error) {
    return { entry, reason: error instanceof GitOutputLimitError ? TOO_LARGE : "The Git base entry could not be read" };
  }
}

interface WorkingPath {
  path: string;
  stats: BigIntStats | null;
  /** On Linux the descriptor anchors the final path while we read it. */
  parent?: FileHandle;
}

async function checkedPath(dir: string, projectPath: string, tracked = false): Promise<WorkingPath> {
  const segments = projectPath.split("/");
  if (process.platform === "linux") {
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    let parent = await open("/", flags);
    try {
      const scope = dir.split("/").filter(Boolean);
      const ancestors = [...scope, ...segments.slice(0, -1)];
      for (const [index, part] of ancestors.entries()) {
        const path = `/proc/self/fd/${parent.fd}/${part}`;
        if (index >= scope.length) {
          const stats = await pathStats(path);
          if (!stats || stats.isFile()) {
            await parent.close();
            return { path: "", stats: null };
          }
        }
        const next = await open(path, flags);
        await parent.close();
        parent = next;
      }
      const path = `/proc/self/fd/${parent.fd}/${segments.at(-1)}`;
      const stats = await pathStats(path);
      return { path, stats: tracked && stats?.isDirectory() ? null : stats, parent };
    } catch (error) {
      await parent.close();
      if (errorCode(error) === "ENOENT") return { path: "", stats: null };
      throw error;
    }
  }
  let path = dir;
  for (const part of segments.slice(0, -1)) {
    path = join(path, part);
    const stats = await pathStats(path);
    if (!stats) return { path: "", stats: null };
    if (stats.isFile()) return absentWorkingPath(path, stats);
    if (!stats.isDirectory()) throw new Error("Unsafe working path");
  }
  path = join(path, segments.at(-1)!);
  const stats = await pathStats(path);
  if (tracked && stats?.isDirectory()) return absentWorkingPath(path, stats);
  if (stats && process.platform === "darwin" && !(await matchesDarwinSpelling(path, stats))) {
    return { path, stats: null };
  }
  return { path, stats };
}

async function absentWorkingPath(path: string, replacement: BigIntStats): Promise<WorkingPath> {
  // A directory is no file entry, and a regular file cannot have descendants. Confirm the
  // containing path has no symlinks without opening the replacement or anything inside it.
  if (process.platform === "darwin") {
    const parent = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | DARWIN_NOFOLLOW_ANY);
    try {
      if (!sameEntry(replacement, await pathStats(path))) throw new Error(CHANGED);
    } finally {
      await parent.close();
    }
  }
  return { path, stats: null };
}

async function matchesDarwinSpelling(path: string, stats: BigIntStats): Promise<boolean> {
  // On a case-insensitive volume lstat("File") succeeds after "File" is renamed to "file".
  if (!stats.isSymbolicLink()) return (await realpath(path)).normalize() === path.normalize();
  // realpath on a symlink follows its target. Inspect the containing directory for the actual name.
  const directory = dirname(path);
  if ((await realpath(directory)).normalize() !== directory.normalize()) return false;
  const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | DARWIN_NOFOLLOW_ANY);
  try {
    const before = await parent.stat({ bigint: true });
    if (!sameEntry(before, await pathStats(directory))) throw new Error(CHANGED);
    const names = await readdir(directory);
    if (!sameEntry(before, await pathStats(directory))) throw new Error(CHANGED);
    const name = basename(path).normalize();
    return names.some((entry) => entry.normalize() === name);
  } finally {
    await parent.close();
  }
}

async function pathStats(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function sameEntry(before: BigIntStats, after: BigIntStats | null): boolean {
  return !!after && before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

async function readRegular(file: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(bytes, offset, size - offset, offset);
    if (!bytesRead) throw new Error(CHANGED);
    offset += bytesRead;
  }
  return bytes;
}

async function stablePath(dir: string, projectPath: string, expected: BigIntStats): Promise<boolean> {
  const checked = await checkedPath(dir, projectPath);
  try {
    return sameEntry(expected, checked.stats);
  } finally {
    await checked.parent?.close();
  }
}

async function readWorking(
  dir: string, projectPath: string, tracked: boolean,
): Promise<{ entry: GitScanWorkingEntry | null; reason: string | null }> {
  let checked: WorkingPath | undefined;
  try {
    checked = await checkedPath(dir, projectPath, tracked);
    const { path, stats } = checked;
    if (!stats) return { entry: null, reason: null };
    if (!stats.isFile() && !stats.isSymbolicLink()) return { entry: null, reason: "Unsupported working entry type" };
    // Reject on size before opening a working file, and check the opened inode again before reading.
    if (stats.size > GIT_SCAN_MAX_FILE_BYTES) return { entry: null, reason: TOO_LARGE };
    const symlink = stats.isSymbolicLink();
    const darwin = process.platform === "darwin";
    if (!darwin && !checked.parent) return { entry: null, reason: UNREADABLE };

    let bytes: Buffer;
    if (symlink && checked.parent) {
      bytes = await readlink(path, { encoding: "buffer" });
    } else {
      const flags = darwin ? DARWIN_NOFOLLOW_ANY | (symlink ? DARWIN_OPEN_SYMLINK : 0) : constants.O_NOFOLLOW;
      const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | flags);
      try {
        const opened = await file.stat({ bigint: true });
        if (!sameEntry(stats, opened)) throw new Error(CHANGED);
        // macOS has no fd-relative readlink in Node. Only accept link text while both the pinned
        // symlink and the no-follow path still identify that entry. readlink never opens its target.
        bytes = symlink ? await readlink(path, { encoding: "buffer" }) : await readRegular(file, Number(stats.size));
        if (!sameEntry(stats, await file.stat({ bigint: true }))) throw new Error(CHANGED);
      } finally {
        await file.close();
      }
    }
    if (!(await stablePath(dir, projectPath, stats))) throw new Error(CHANGED);
    if (bytes.length > GIT_SCAN_MAX_FILE_BYTES) return { entry: null, reason: TOO_LARGE };
    return {
      entry: { mode: symlink ? "120000" : (stats.mode & 0o100n) ? "100755" : "100644", bytes, sha256: sha256(bytes) },
      reason: null,
    };
  } catch (error) {
    return { entry: null, reason: error instanceof Error && error.message === CHANGED ? CHANGED : UNREADABLE };
  } finally {
    await checked?.parent?.close();
  }
}

function isBinary(bytes: Buffer | null | undefined): boolean {
  if (!bytes) return false;
  if (bytes.includes(0)) return true;
  try {
    utf8.decode(bytes);
    return false;
  } catch {
    return true;
  }
}

function nonIdentity(entry: GitScanEntry): GitScanEntry["wholeEntryReason"] {
  if (entry.otherReason || !entry.attributes.base || !entry.attributes.current) return "unavailable";
  if (entry.status.some((status) => status.kind === "rename")) return "rename";
  if (entry.path && basename(entry.path) === ".gitattributes") return "gitattributes";
  if (entry.base?.mode === "120000" || entry.current?.mode === "120000") return "symlink";
  const before = entry.base?.raw;
  const working = entry.base?.working;
  const current = entry.current?.bytes;
  if (
    isBinary(before) || isBinary(working) || isBinary(current)
    || entry.attributes.base.diff?.equals(Buffer.from("unset"))
    || entry.attributes.current.diff?.equals(Buffer.from("unset"))
  ) return "binary";
  for (const attrs of [entry.attributes.base, entry.attributes.current]) {
    if (attrs.filter !== null || attrs.ident !== null || attrs["working-tree-encoding"] !== null) return "conversion";
  }
  if (before?.includes(0x0d) || current?.includes(0x0d) || (before && working && !before.equals(working))) return "conversion";
  return null;
}

function hasTrackedEntry(base: TreeEntry | null | undefined, status: GitScanStatus[]): boolean {
  return !!base || status.some((record) => record.kind === "ordinary" || record.kind === "rename");
}

async function usablePath(scope: ScopedProject, projectPath: string, tracked: boolean): Promise<boolean> {
  try {
    const checked = await checkedPath(scope.dir, projectPath, tracked);
    await checked.parent?.close();
    return !checked.stats || checked.stats.isFile() || checked.stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Read exact worktree and base evidence for scoped status entries and any extra repo-relative ledger paths. */
export async function scanGitChanges(
  scope: GitScanScope, head: GitScanHead, additionalPaths: readonly string[] = [],
): Promise<GitScanResult> {
  if (head.oid !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head.oid)) throw new Error("Invalid Git base OID");
  if (head.branch !== null && !head.branch.startsWith("refs/heads/")) throw new Error("Invalid Git branch");
  const project = await resolveScope(scope);
  const status = parseStatus(await git(project.root, [
    "status", "--porcelain=v2", "-z", "--branch", "--no-ahead-behind", "--untracked-files=all",
    "--ignore-submodules=none", "--", ...project.pathspec,
  ]));
  if (!statusMatchesHead(status, head)) throw new GitScanBaseChangedError();
  const paths = candidates(project, status.entries, additionalPaths);
  const baseTree = paths.size ? await readBaseTree(project, head.oid) : new Map<string, TreeEntry>();
  const submodules = submodulePaths(baseTree, paths);
  const entries: GitScanEntry[] = [];
  const ready: Candidate[] = [];
  for (const [id, candidate] of paths) {
    const tree = baseTree.get(id);
    const tracked = hasTrackedEntry(tree, candidate.status);
    let otherReason: string | null = null;
    if (insideSubmodule(candidate.pathBytes, submodules)) otherReason = SUBMODULE;
    else if (candidate.status.some((record) => record.kind === "unmerged")) otherReason = "Unmerged Git entry";
    else if (candidate.status.some((record) => record.kind === "ignored")) otherReason = "Ignored by Git";
    else if (!candidate.projectPath || !candidate.path) otherReason = "Unsupported Git pathname";
    else if (candidate.directory) otherReason = "Unsupported working directory entry";
    else if (!(await usablePath(project, candidate.projectPath, tracked))) otherReason = UNREADABLE;
    else ready.push(candidate);
    entries.push({
      path: candidate.path, projectPath: candidate.projectPath, pathBytes: candidate.pathBytes, status: candidate.status,
      base: tree ? { ...tree, raw: null, working: null, workingSha256: null } : null, current: null,
      attributes: { base: null, current: null }, conversion: "whole", wholeEntryReason: "unavailable", otherReason,
    });
  }

  const ignored = await ignoredPaths(project.root, ready);
  const readable = ready.filter((candidate) => !ignored.has(key(candidate.pathBytes)));
  for (const entry of entries) {
    if (ignored.has(key(entry.pathBytes))) entry.otherReason = "Ignored by Git";
  }
  if (readable.length) {
    const baseSource = head.oid ?? (await git(project.root, ["hash-object", "-t", "tree", "--stdin"])).toString("ascii").trim();
    const [baseAttributes, currentAttributes] = await Promise.all([
      readAttributes(project.root, readable, baseSource), readAttributes(project.root, readable),
    ]);
    for (const entry of entries) {
      if (entry.otherReason) continue;
      const id = key(entry.pathBytes);
      entry.attributes = { base: baseAttributes.get(id)!, current: currentAttributes.get(id)! };
      const current = await readWorking(project.dir, entry.projectPath!, hasTrackedEntry(entry.base, entry.status));
      entry.current = current.entry;
      // Oversized or unsafe working entries are already unavailable. Avoid running a filter on their base.
      if (current.reason) {
        entry.otherReason = current.reason;
        continue;
      }
      const base = await readBase(project.root, head, entry.path!, baseTree.get(id));
      entry.base = base.entry;
      entry.otherReason = base.reason;
      entry.wholeEntryReason = nonIdentity(entry);
      entry.conversion = entry.wholeEntryReason ? "whole" : "identity";
    }
  }
  await verifyHead(project.root, head);
  return { entries };
}
