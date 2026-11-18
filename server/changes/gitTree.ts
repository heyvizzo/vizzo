import { spawn } from "node:child_process";
import { copyFile, lstat, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type GitFileMode = "100644" | "100755" | "120000";
export type GitTreeEntry = { mode: GitFileMode; oid: string };
export type GitEntryChange = { path: string; base: GitTreeEntry | null; next: GitTreeEntry | null };

export type FrozenGitEntry = { path: string } & (
  | { mode: "0"; content: null; kind: "whole" }
  | { mode: GitFileMode; content: Buffer; kind: "partial" | "whole" }
);

type Repository = { root: string; indexPath: string };
type BuildCommitRequest = Repository & {
  base: string | null;
  entries: readonly FrozenGitEntry[];
  message: string;
};

type GitResult = { code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: string };

function runGit(root: string, index: string, args: string[], input?: string | Buffer): Promise<GitResult> {
  const env = { ...process.env };
  // Use the discovered repository and private index even when launched from a Git subprocess.
  for (const name of [
    "GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE", "GIT_ATTR_SOURCE", "GIT_PREFIX", "GIT_QUARANTINE_PATH",
  ]) delete env[name];
  env.GIT_INDEX_FILE = index;
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_OPTIONAL_LOCKS = "0";

  return new Promise((resolve, reject) => {
    const child = spawn("git", [
      "--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.splitIndex=false",
      "-c", "core.fsmonitor=false", "-c", "core.sparseCheckout=false", "-c", "index.skipHash=false", ...args,
    ], { cwd: root, env, stdio: "pipe" });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
    child.on("close", (code, signal) => resolve({
      code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8").trim(),
    }));
    child.stdin.end(input);
  });
}

function gitError(args: string[], result: GitResult): Error {
  return new Error(`git ${args.find((arg) => !arg.startsWith("-"))} failed: ${result.stderr || result.signal || result.code}`);
}

async function git(root: string, index: string, args: string[], input?: string | Buffer): Promise<Buffer> {
  const result = await runGit(root, index, args, input);
  if (result.code !== 0) throw gitError(args, result);
  return result.stdout;
}

async function withTemporaryIndex<T>(use: (index: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "vizzo-commit-"));
  try { return await use(join(dir, "index")); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

async function fileInfo(path: string) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

async function copyIndex(source: string, destination: string): Promise<void> {
  const info = await fileInfo(source);
  if (info === null) return;
  if (!info.isFile()) throw new Error("The Git index must be a regular file.");
  await copyFile(source, destination);
  // Git uses the index mtime to detect racy stat information and invalidate it when writing.
  // Round down so converting the filesystem timestamp cannot make a racy entry appear clean.
  const mtime = new Date(Number(info.mtimeNs / 1_000_000n) - 1);
  await utimes(destination, new Date(Number(info.atimeMs)), mtime);
}

async function assertNoOperation(root: string, index: string): Promise<void> {
  const gitDir = (await git(root, index, ["rev-parse", "--absolute-git-dir"])).toString("utf8").replace(/\n$/, "");
  for (const [operation, markers] of [
    ["merge", ["MERGE_HEAD"]],
    ["rebase", ["rebase-merge", "rebase-apply"]],
    ["cherry-pick", ["CHERRY_PICK_HEAD"]],
    ["revert", ["REVERT_HEAD"]],
    ["cherry-pick or revert", ["sequencer"]],
  ] as const) {
    for (const marker of markers) {
      if (await fileInfo(join(gitDir, marker))) throw new Error(`A Git ${operation} is in progress.`);
    }
  }
}

async function zeroOid(root: string, index: string): Promise<string> {
  const format = (await git(root, index, ["rev-parse", "--show-object-format"])).toString("ascii").trim();
  if (format === "sha1") return "0".repeat(40);
  if (format === "sha256") return "0".repeat(64);
  throw new Error(`Unsupported Git object format: ${format}`);
}

// Latin-1 gives arbitrary Git path bytes a reversible map key, including paths the scanner cannot present as UTF-8.
function pathKey(path: string): string {
  return Buffer.from(path).toString("latin1");
}

function pathAncestors(path: string): string[] {
  const ancestors: string[] = [];
  for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
    ancestors.push(path.slice(0, slash));
  }
  return ancestors;
}

function selectedPaths(entries: readonly {path: string}[]): Set<string> {
  if (!entries.length) throw new Error("No paths selected for this commit.");
  const selected = new Set<string>();
  for (const { path } of entries) {
    if (path.includes("\0") || Buffer.from(path).toString("utf8") !== path ||
        path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
      throw new Error(`Invalid repository-relative path: ${JSON.stringify(path)}`);
    }
    const key = pathKey(path);
    if (selected.has(key)) throw new Error(`Path selected more than once: ${JSON.stringify(path)}`);
    selected.add(key);
  }
  return selected;
}

type ListedEntry = { mode: string; oid: string; stage: string };

// Both ls-tree and ls-files use a tab before the raw path and a NUL record separator.
function readEntries(output: Buffer, tree: boolean): Map<string, ListedEntry[]> {
  const entries = new Map<string, ListedEntry[]>();
  for (const record of output.toString("latin1").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, second, third] = record.slice(0, tab).split(" ");
    if (tab < 0 || !mode || !second || !third) throw new Error("Git returned an invalid entry.");
    const path = record.slice(tab + 1);
    const entry = { mode, oid: tree ? third : second, stage: tree ? "0" : third };
    const atPath = entries.get(path);
    if (atPath) atPath.push(entry);
    else entries.set(path, [entry]);
  }
  return entries;
}

function baseEntryAt(entries: Map<string, ListedEntry[]>, path: string): GitTreeEntry | null {
  const entry = entries.get(pathKey(path))?.[0];
  if (!entry) return null;
  const { mode, oid } = entry;
  if (mode === "100644" || mode === "100755" || mode === "120000") return { mode, oid };
  if (mode === "160000") throw new Error(`Vizzo cannot commit a submodule path: ${JSON.stringify(path)}`);
  throw new Error(`Unsupported Git entry mode at ${JSON.stringify(path)}: ${mode}`);
}

function assertStaging(
  real: Map<string, ListedEntry[]>,
  entries: readonly {path: string; base: GitTreeEntry | null}[],
): void {
  for (const { path, base } of entries) {
    if (!matchesEntry(real, path, base)) throw new Error(`This path has staged changes: ${JSON.stringify(path)}`);
  }
}

function matchesEntry(entries: Map<string, ListedEntry[]>, path: string, expected: GitTreeEntry | null): boolean {
  const actual = entries.get(pathKey(path));
  if (!expected) return !actual;
  const entry = actual?.[0];
  return actual?.length === 1 && entry?.stage === "0" && entry.mode === expected.mode && entry.oid === expected.oid;
}

// A file/directory transition can evict entries implicitly in update-index. Require every displaced path
// to have its own selected deletion, including paths staged directly into the real index.
function assertNoUnselectedCollisions(
  existing: Map<string, ListedEntry[]>,
  selected: Set<string>,
  additions: readonly string[],
): void {
  const targetPaths = new Set(additions);
  const targetAncestors = new Set(additions.flatMap(pathAncestors));
  for (const path of targetPaths) {
    if (targetAncestors.has(path)) throw new Error(`Selected paths conflict: ${JSON.stringify(Buffer.from(path, "latin1").toString())}`);
  }
  for (const path of existing.keys()) {
    if (selected.has(path)) continue;
    if (targetAncestors.has(path) || pathAncestors(path).some((ancestor) => targetPaths.has(ancestor))) {
      throw new Error(`An unselected Git entry conflicts with a selected path: ${JSON.stringify(Buffer.from(path, "latin1").toString())}`);
    }
  }
}

const isAttributes = (path: string): boolean => path === ".gitattributes" || path.endsWith("/.gitattributes");
const nonIdentity = (path: string): Error => new Error(
  `Changed meanwhile: review again. Partial selection requires identity conversion for ${JSON.stringify(path)}.`,
);

type GitIndexEdit = { path: string; next: GitTreeEntry | null };

function assertAppliedEntries(
  actual: Map<string, ListedEntry[]>,
  edits: readonly GitIndexEdit[],
  target: "commit tree" | "prepared index",
): void {
  for (const { path, next } of edits) {
    // Git may report success from --index-info even when path protection skips an entry.
    if (!matchesEntry(actual, path, next)) {
      throw new Error(`Git did not apply the selected entry to the ${target}: ${JSON.stringify(path)}`);
    }
  }
}

async function updateEntries(
  root: string,
  index: string,
  zero: string,
  edits: readonly GitIndexEdit[],
  fromRealIndex = false,
): Promise<void> {
  if (!edits.length) return;
  const removals: string[] = [];
  const additions: string[] = [];
  for (const { path, next } of edits) {
    if (next) additions.push(`${next.mode} ${next.oid}\t${path}\0`);
    else removals.push(`0 ${zero}\t${path}\0`);
  }
  const options = fromRealIndex ? ["--no-split-index"] : [];
  await git(root, index, ["update-index", ...options, "-z", "--index-info"], removals.concat(additions).join(""));
}

async function writeTree(root: string, index: string): Promise<string> {
  return (await git(root, index, ["write-tree"])).toString("ascii").trim();
}

type FrozenContent = Extract<FrozenGitEntry, {content: Buffer}>;
type GitIndexAddition = { path: string; next: GitTreeEntry };

async function hashEntry(root: string, index: string, entry: FrozenContent, attributes?: string): Promise<GitIndexAddition> {
  const { path, mode, content } = entry;
  const args = attributes && entry.kind === "whole" && mode !== "120000"
    ? [`--attr-source=${attributes}`, "hash-object", "-w", `--path=${path}`, "--stdin"]
    : ["hash-object", "-w", "--no-filters", "--stdin"];
  const oid = (await git(root, index, args, content)).toString("ascii").trim();
  return { path, next: { mode, oid } };
}

async function prepareAttributes(
  root: string, index: string, zero: string, entries: readonly FrozenContent[],
): Promise<{ tree: string; entries: GitIndexAddition[] }> {
  const seed = new Map<string, GitIndexAddition>();
  for (const entry of entries) seed.set(entry.path, await hashEntry(root, index, entry));
  await updateEntries(root, index, zero, [...seed.values()]);
  const firstTree = await writeTree(root, index);

  async function convert(tree: string): Promise<Map<string, GitIndexAddition>> {
    const converted = new Map(seed);
    for (const entry of entries) {
      if (entry.mode !== "120000") converted.set(entry.path, await hashEntry(root, index, entry, tree));
    }
    return converted;
  }

  const first = await convert(firstTree);
  const firstEntries = [...first.values()];
  if (firstEntries.every(({ path, next }) => next.oid === seed.get(path)?.next.oid)) {
    return { tree: firstTree, entries: firstEntries };
  }

  // An attribute file can convert itself, or change the conversion of another attribute file.
  // Use a rebuilt candidate only if conversion reproduces exactly the attributes it contains.
  await updateEntries(root, index, zero, firstEntries);
  const secondTree = await writeTree(root, index);
  const second = await convert(secondTree);
  if (firstEntries.some(({ path, next }) => next.oid !== second.get(path)?.next.oid)) {
    throw new Error("The selected .gitattributes conversion could not be stabilized.");
  }
  return { tree: secondTree, entries: firstEntries };
}

async function assertPartialIdentity(
  root: string,
  index: string,
  attributes: string,
  base: string | null,
  paths: readonly FrozenContent[],
  baseEntries: Map<string, ListedEntry[]>,
): Promise<void> {
  if (!paths.length) return;
  const attrSource = `--attr-source=${attributes}`;
  const output = await git(root, index, [attrSource, "check-attr", "-z", "--stdin", "--all"],
    paths.map(({ path }) => `${path}\0`).join(""));
  const fields = output.toString("utf8").split("\0");
  // A named query renders a value like filter=unspecified the same way as an absent attribute.
  // --all omits genuinely absent attributes and identifies every explicit conversion setting.
  for (let n = 0; n < fields.length - 1; n += 3) {
    const [path, attr, value] = fields.slice(n, n + 3);
    if (!path || !attr || value === undefined) throw new Error("Git returned an invalid attribute record.");
    if (attr === "filter" || attr === "ident" || attr === "working-tree-encoding") throw nonIdentity(path);
  }
  for (const { path, mode, content } of paths) {
    if (mode === "120000" || isAttributes(path) || content.includes(0x0d) || content.includes(0)) throw nonIdentity(path);
    const before = baseEntryAt(baseEntries, path);
    if (!before) continue;
    if (before.mode === "120000") throw nonIdentity(path);
    const raw = await git(root, index, ["cat-file", "blob", before.oid]);
    const working = await git(root, index, [attrSource, "cat-file", "--filters", `${base}:${path}`]);
    if (raw.includes(0x0d) || raw.includes(0) || !raw.equals(working)) throw nonIdentity(path);
  }
}

/**
 * Build a commit object from a captured base and frozen repository-relative entries.
 * Partial content is the complete result of the scanner's selected byte substitutions into the base.
 * The caller must hold the real index lock. This only writes temporary indexes and Git objects.
 */
export async function buildCommitTree({ root, indexPath, base, entries, message }: BuildCommitRequest): Promise<{
  tree: string;
  commit: string;
  entries: GitEntryChange[];
}> {
  const selected = selectedPaths(entries);
  return withTemporaryIndex(async (treeIndex) => {
    await assertNoOperation(root, treeIndex);
    const zero = await zeroOid(root, treeIndex);
    if (base !== null && (base.length !== zero.length || !/^[0-9a-f]+$/.test(base))) {
      throw new Error("Invalid captured Git commit OID.");
    }
    const baseEntries = base
      ? readEntries(await git(root, treeIndex, ["ls-tree", "-rz", "--full-tree", base]), true)
      : new Map<string, ListedEntry[]>();
    const startingEntries = entries.map(({ path }) => ({ path, base: baseEntryAt(baseEntries, path) }));
    const content = entries.filter((entry): entry is FrozenContent => entry.mode !== "0");
    const additions = content.map(({ path }) => pathKey(path));
    assertNoUnselectedCollisions(baseEntries, selected, additions);
    await withTemporaryIndex(async (index) => {
      await copyIndex(indexPath, index);
      const real = readEntries(await git(root, index, ["ls-files", "-z", "--stage"]), false);
      assertStaging(real, startingEntries);
      assertNoUnselectedCollisions(real, selected, additions);
    });

    await git(root, treeIndex, ["read-tree", base ?? "--empty"]);
    const deletions = entries.filter(({ mode }) => mode === "0").map(({ path }) => ({ path, next: null }));
    await updateEntries(root, treeIndex, zero, deletions);
    const attributeFiles = content.filter(({ path }) => isAttributes(path));
    for (const entry of attributeFiles) if (entry.kind !== "whole") throw nonIdentity(entry.path);
    const attributes = await prepareAttributes(root, treeIndex, zero, attributeFiles);
    await assertPartialIdentity(root, treeIndex, attributes.tree, base,
      content.filter(({ kind }) => kind === "partial"), baseEntries);

    const changes: GitIndexEdit[] = [];
    for (const entry of content) {
      if (!isAttributes(entry.path)) changes.push(await hashEntry(root, treeIndex, entry, attributes.tree));
    }
    await updateEntries(root, treeIndex, zero, changes);
    const tree = changes.length ? await writeTree(root, treeIndex) : attributes.tree;
    const next = new Map([...attributes.entries, ...changes].map((entry) => [entry.path, entry.next]));
    const applied = startingEntries.map((entry) => ({ ...entry, next: next.get(entry.path) ?? null }));
    const actualTree = readEntries(await git(root, treeIndex, ["ls-tree", "-rz", "--full-tree", tree]), true);
    assertAppliedEntries(actualTree, applied, "commit tree");

    const signArgs = ["config", "--bool", "--get", "commit.gpgSign"];
    const sign = await runGit(root, treeIndex, signArgs);
    if (sign.code !== 0 && sign.code !== 1) throw gitError(signArgs, sign);
    const args = ["commit-tree", tree, "-F", "-"];
    if (base) args.push("-p", base);
    if (sign.stdout.toString("ascii").trim() === "true") args.push("-S");
    const commit = (await git(root, treeIndex, args, message)).toString("ascii").trim();

    return { tree, commit, entries: applied };
  });
}

/**
 * Recheck staging against the journalable base entries and return a checksummed index to install later.
 * The caller must hold the real index lock. Git may refresh a shared-index cache timestamp while reading a
 * split index and read the working tree to verify potentially racy stat records. That check only updates
 * cached stat information. The returned bytes are self-contained.
 */
export async function prepareIndexBytes({ root, indexPath, entries }: Repository & {
  entries: readonly GitEntryChange[];
}): Promise<Buffer> {
  const selected = selectedPaths(entries);
  return withTemporaryIndex(async (index) => {
    await copyIndex(indexPath, index);
    const real = readEntries(await git(root, index, ["ls-files", "-z", "--stage"]), false);
    assertStaging(real, entries);
    assertNoUnselectedCollisions(real, selected, entries.filter(({ next }) => next).map(({ path }) => pathKey(path)));
    await updateEntries(root, index, await zeroOid(root, index), entries, true);
    const prepared = readEntries(await git(root, index, ["ls-files", "-z", "--stage"]), false);
    assertAppliedEntries(prepared, entries, "prepared index");
    return readFile(index);
  });
}
