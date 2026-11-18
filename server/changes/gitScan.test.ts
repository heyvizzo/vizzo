import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GIT_SCAN_MAX_FILE_BYTES, GitScanBaseChangedError, scanGitChanges, type GitScanEntry, type GitScanHead,
} from "./gitScan.ts";

const temporary: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(root: string, args: string[], input?: Buffer): string {
  return execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }).trimEnd();
}

async function sandbox(): Promise<string> {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  const dir = await realpath(await mkdtemp(join(tmpdir(), "git-scan-")));
  temporary.push(dir);
  return dir;
}

function init(root: string, format: string): void {
  git(root, ["init", "--quiet", "--initial-branch=main", `--ref-format=${format}`]);
  git(root, ["config", "user.name", "Vizzo Test"]);
  git(root, ["config", "user.email", "vizzo@example.test"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["config", "core.filemode", "true"]);
}

function head(root: string, branch: string | null = "refs/heads/main"): GitScanHead {
  return { branch, oid: git(root, ["rev-parse", "HEAD"]) };
}

function commit(root: string): GitScanHead {
  git(root, ["add", "-A"]);
  git(root, ["commit", "--quiet", "-m", "test revision"]);
  return head(root);
}

function byPath(entries: GitScanEntry[], path: string): GitScanEntry {
  const entry = entries.find((entry) => entry.path === path);
  expect(entry, path).toBeDefined();
  return entry!;
}

async function fixture(format: string): Promise<string> {
  const root = await sandbox();
  init(root, format);
  return root;
}

describe.each(["files", "reftable"])("Git scan (%s refs)", (format) => {
  it("reads raw scoped status, staged metadata, renames and exact current bytes", async () => {
    const root = await fixture(format);
    const folder = "[project]* !\t\n";
    const dir = join(root, folder);
    await mkdir(dir);
    await mkdir(join(root, "project"));
    const name = " \tname\n\"😀 .txt";
    const original = "renamed\nfrom";
    const renamed = " renamed\tto";
    await writeFile(join(dir, name), "one\ntwo\n");
    await writeFile(join(dir, original), "same bytes\n");
    await writeFile(join(dir, "deleted"), "bye\n");
    await writeFile(join(dir, "recreated"), "previous\n");
    await writeFile(join(root, "project", "outside"), "outside\n");
    const base = commit(root);
    await writeFile(join(dir, name), "one\nstaged\n");
    git(root, ["add", "--", join(dir, name)]);
    await writeFile(join(dir, name), "one\nstaged\nworking\n");
    await chmod(join(dir, name), 0o755);
    await git(root, ["mv", "--", join(dir, original), join(dir, renamed)]);
    await unlink(join(dir, "deleted"));
    git(root, ["rm", "--", join(dir, "recreated")]);
    await writeFile(join(dir, "recreated"), "again\n");
    await writeFile(join(dir, "empty"), "");
    await writeFile(join(root, "project", "outside"), "outside change\n");
    await writeFile(join(root, "untracked-outside"), "outside\n");

    const { entries } = await scanGitChanges({ worktreeRoot: root, projectDir: dir }, base);
    expect(entries.map((entry) => entry.projectPath).sort()).toEqual([name, original, renamed, "deleted", "empty", "recreated"].sort());
    const tracked = byPath(entries, `${folder}/${name}`);
    const trackedBase = Buffer.from("one\ntwo\n");
    const trackedBytes = Buffer.from("one\nstaged\nworking\n");
    expect(tracked.pathBytes).toEqual(Buffer.from(`${folder}/${name}`));
    expect(tracked.status[0]).toMatchObject({
      kind: "ordinary", xy: "MM", modes: ["100644", "100644", "100755"],
      oids: [git(root, ["rev-parse", `HEAD:${folder}/${name}`]), git(root, ["rev-parse", `:${folder}/${name}`])],
    });
    expect(tracked.base).toMatchObject({ mode: "100644", raw: trackedBase, working: trackedBase });
    expect(tracked.current).toEqual({
      mode: "100755", bytes: trackedBytes, sha256: createHash("sha256").update(trackedBytes).digest("hex"),
    });
    expect(tracked.conversion).toBe("identity");
    const from = byPath(entries, `${folder}/${original}`);
    const to = byPath(entries, `${folder}/${renamed}`);
    expect(from.status[0]).toBe(to.status[0]);
    expect(to.status[0]).toMatchObject({
      kind: "rename", xy: "R.", score: "R100", pathBytes: Buffer.from(`${folder}/${renamed}`),
      originalPathBytes: Buffer.from(`${folder}/${original}`),
    });
    expect(from.base?.working).toEqual(Buffer.from("same bytes\n"));
    expect(from.current).toBeNull();
    expect(to.base).toBeNull();
    expect(to.current?.bytes).toEqual(Buffer.from("same bytes\n"));
    expect(to.wholeEntryReason).toBe("rename");
    expect(byPath(entries, `${folder}/deleted`).current).toBeNull();
    expect(byPath(entries, `${folder}/empty`)).toMatchObject({ base: null, current: { bytes: Buffer.alloc(0) } });
    expect(byPath(entries, `${folder}/recreated`).status.map((status) => status.kind)).toEqual(["ordinary", "untracked"]);
    expect(byPath(entries, `${folder}/recreated`).current?.bytes).toEqual(Buffer.from("again\n"));
    await expect(scanGitChanges({ worktreeRoot: root, projectDir: dir }, base, ["project/outside"])).rejects.toThrow(/outside the project/);
  });

  it("uses a linked worktree's index and the caller's next HEAD capture", async () => {
    const sandboxDir = await sandbox();
    const root = join(sandboxDir, "root");
    await mkdir(root);
    init(root, format);
    await writeFile(join(root, "entry"), "one\n");
    const first = commit(root);
    const linked = join(sandboxDir, "linked");
    git(root, ["worktree", "add", "-b", "linked", linked]);
    const scope = { worktreeRoot: linked, projectDir: linked };
    const firstLinked = head(linked, "refs/heads/linked");
    await writeFile(join(linked, "entry"), "two\n");
    git(linked, ["add", "entry"]);
    expect(byPath((await scanGitChanges(scope, firstLinked)).entries, "entry").status[0]?.xy).toBe("M.");
    expect((await scanGitChanges({ worktreeRoot: root, projectDir: root }, first)).entries).toEqual([]);
    git(linked, ["commit", "--quiet", "-m", "advance"]);
    const second = head(linked, "refs/heads/linked");
    await writeFile(join(linked, "entry"), "now\n");
    await expect(scanGitChanges(scope, firstLinked)).rejects.toBeInstanceOf(GitScanBaseChangedError);
    expect(byPath((await scanGitChanges(scope, second)).entries, "entry").base?.working).toEqual(Buffer.from("two\n"));

    git(linked, ["update-ref", "refs/heads/linked", first.oid!]);
    await expect(scanGitChanges(scope, second)).rejects.toBeInstanceOf(GitScanBaseChangedError);
    expect(byPath((await scanGitChanges(scope, firstLinked)).entries, "entry").base?.working).toEqual(Buffer.from("one\n"));
    git(linked, ["branch", "same-oid"]);
    git(linked, ["symbolic-ref", "HEAD", "refs/heads/same-oid"]);
    await expect(scanGitChanges(scope, firstLinked)).rejects.toBeInstanceOf(GitScanBaseChangedError);
    expect(byPath((await scanGitChanges(scope, head(linked, "refs/heads/same-oid"))).entries, "entry").base?.working)
      .toEqual(Buffer.from("one\n"));
    git(linked, ["update-ref", "--no-deref", "HEAD", first.oid!]);
    expect(byPath((await scanGitChanges(scope, head(linked, null))).entries, "entry").base?.working)
      .toEqual(Buffer.from("one\n"));
  });

  it("reads an unborn base and skips ignored evidence without changing the real index", async () => {
    const root = await fixture(format);
    await writeFile(join(root, ".gitignore"), "*.private\n!keep.private\n");
    await writeFile(join(root, "skip.private"), "ignore this\n");
    await writeFile(join(root, "keep.private"), "read this\n");
    await writeFile(join(root, ":(exclude)literal"), "literal path\n");
    await writeFile(join(root, "\ufeffname"), "byte order mark is part of the filename\n");
    await writeFile(join(root, "staged"), "tracked\n");
    git(root, ["add", "staged"]);
    const indexPath = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const before = await readFile(indexPath);
    const hookOutput = join(root, ".git", "fsmonitor-ran");
    const hook = join(root, ".git", "test-fsmonitor");
    await writeFile(hook, `#!/bin/sh\ntouch '${hookOutput}'\n`);
    await chmod(hook, 0o755);
    git(root, ["config", "core.fsmonitor", hook]);
    const traceOutput = join(root, ".git", "trace");
    vi.stubEnv("GIT_TRACE", traceOutput);
    vi.stubEnv("GIT_TRACE2_EVENT", traceOutput);

    const scope = { worktreeRoot: root, projectDir: root };
    const base = { branch: "refs/heads/main", oid: null };
    expect((await scanGitChanges(scope, base)).entries.some((entry) => entry.path === "skip.private")).toBe(false);
    const { entries } = await scanGitChanges(scope, base, ["skip.private", "missing"]);
    expect(byPath(entries, "skip.private")).toMatchObject({ base: null, current: null, otherReason: "Ignored by Git" });
    expect(byPath(entries, "missing")).toMatchObject({ base: null, current: null, otherReason: null });
    expect(byPath(entries, "staged")).toMatchObject({ base: null, otherReason: null, status: [{ kind: "ordinary", xy: "A." }] });
    expect(byPath(entries, "keep.private").current?.bytes).toEqual(Buffer.from("read this\n"));
    expect(byPath(entries, ":(exclude)literal").current?.bytes).toEqual(Buffer.from("literal path\n"));
    expect(byPath(entries, "\ufeffname").current?.bytes).toEqual(Buffer.from("byte order mark is part of the filename\n"));
    expect(await readFile(indexPath)).toEqual(before);
    await expect(readFile(hookOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(traceOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports conversion using live and historical parent attributes independently", async () => {
    const root = await fixture(format);
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    const baseAttrs = [
      "*.flt filter=unspecified", "*.ptr filter=lfs-test", "*.latin working-tree-encoding=ISO-8859-1",
      "*.ident ident", "*.bin binary", "*.norm text eol=crlf", "",
    ].join("\n");
    await writeFile(join(root, ".gitattributes"), baseAttrs);
    await writeFile(join(projectDir, ".gitattributes"), "*.txt text\n");
    git(root, ["config", "filter.unspecified.clean", "sed s/^hydrated:/raw:/"]);
    git(root, ["config", "filter.unspecified.smudge", "sed s/^raw:/hydrated:/"]);
    git(root, ["config", "filter.lfs-test.clean", "sed 's/^large-object:/version https:/'"]);
    git(root, ["config", "filter.lfs-test.smudge", "sed 's/^version https:/large-object:/'"]);
    const originals = {
      "file.flt": Buffer.from("hydrated:base\n"),
      "file.ptr": Buffer.from("large-object://git-lfs.github.com/spec/v1\noid sha256:000\nsize 42\n"),
      "file.latin": Buffer.from([0xe9, 0x0a]),
      "file.ident": Buffer.from("$Id$\n"),
      "file.bin": Buffer.from("ascii bytes marked binary\n"),
      "file.realbin": Buffer.from([0, 255, 0x0a]),
      "file.norm": Buffer.from("normalized\r\n"),
      "file.cr": Buffer.from("base without CR\n"),
      "file.txt": Buffer.from("identity\n"),
      "current.txt": Buffer.from("current-only attribute\n"),
      "unset.txt": Buffer.from("ambiguous unset attribute\n"),
    };
    for (const [file, bytes] of Object.entries(originals)) await writeFile(join(projectDir, file), bytes);
    const base = commit(root);
    await writeFile(join(root, ".gitattributes"), [
      "*.flt !filter", "*.ptr -filter", "*.latin !working-tree-encoding", "*.ident !ident",
      "current.txt filter=unspecified", "unset.txt filter=unset", "",
    ].join("\n"));
    await writeFile(join(projectDir, ".gitattributes"), "*.txt text\n# changed\n");
    for (const [file, bytes] of Object.entries(originals)) {
      await writeFile(join(projectDir, file), Buffer.concat([bytes, Buffer.from(file === "file.cr" ? "changed\r\n" : "changed\n")]));
    }

    const { entries } = await scanGitChanges({ worktreeRoot: root, projectDir }, base);
    const local = (name: string) => byPath(entries, `project/${name}`);
    expect(entries.some((entry) => entry.path === ".gitattributes")).toBe(false);
    expect(local("file.flt")).toMatchObject({
      attributes: { base: { filter: Buffer.from("unspecified") }, current: { filter: null } },
      base: { raw: Buffer.from("raw:base\n"), working: originals["file.flt"] },
      conversion: "whole", wholeEntryReason: "conversion", otherReason: null,
    });
    expect(local("file.ptr")).toMatchObject({
      attributes: { base: { filter: Buffer.from("lfs-test") }, current: { filter: Buffer.from("unset") } },
      base: {
        raw: Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:000\nsize 42\n"),
        working: originals["file.ptr"],
      },
      conversion: "whole", wholeEntryReason: "conversion",
    });
    expect(local("file.latin")).toMatchObject({
      attributes: { base: { "working-tree-encoding": Buffer.from("ISO-8859-1") }, current: { "working-tree-encoding": null } },
      base: { working: originals["file.latin"], raw: Buffer.from("é\n") }, conversion: "whole",
    });
    expect(local("file.ident").base?.working?.toString()).toMatch(/^\$Id: [0-9a-f]+ \$\n$/);
    expect(local("file.ident").wholeEntryReason).toBe("conversion");
    expect(local("file.bin").wholeEntryReason).toBe("binary");
    expect(local("file.realbin").wholeEntryReason).toBe("binary");
    expect(local("file.norm")).toMatchObject({
      base: { raw: Buffer.from("normalized\n"), working: Buffer.from("normalized\r\n") }, wholeEntryReason: "conversion",
    });
    expect(local("file.cr").wholeEntryReason).toBe("conversion");
    expect(local("file.txt")).toMatchObject({ wholeEntryReason: null, conversion: "identity", otherReason: null });
    expect(local("current.txt")).toMatchObject({
      attributes: { base: { filter: null }, current: { filter: Buffer.from("unspecified") } }, wholeEntryReason: "conversion",
    });
    expect(local("unset.txt")).toMatchObject({
      attributes: { base: { filter: null }, current: { filter: Buffer.from("unset") } }, wholeEntryReason: "conversion",
    });
    expect(local(".gitattributes").wholeEntryReason).toBe("gitattributes");
  });

  it("keeps symlink bytes, rejects symlink ancestors and classifies gitlinks without path content", async () => {
    const sandboxDir = await sandbox();
    const root = join(sandboxDir, "root");
    const outside = join(sandboxDir, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "out of scope\n");
    init(root, format);
    await mkdir(join(root, "tree"));
    await writeFile(join(root, "tree", "secret"), "in scope before\n");
    await symlink("tree/secret", join(root, "link"));
    const initial = commit(root);
    const sub = join(root, "sub");
    await mkdir(sub);
    init(sub, format);
    await writeFile(join(sub, "inside"), "original\n");
    commit(sub);
    git(root, ["update-index", "--add", "--cacheinfo", `160000,${git(sub, ["rev-parse", "HEAD"])},sub`]);
    git(root, ["commit", "--quiet", "-m", "gitlink"]);
    const base = head(root);
    expect(base).not.toEqual(initial);
    await writeFile(join(sub, "inside"), "dirty submodule\n");
    await rm(join(root, "tree"), { recursive: true });
    await symlink(outside, join(root, "tree"));
    await unlink(join(root, "link"));
    const escapingLink = "../outside/secret";
    await symlink(escapingLink, join(root, "link"));

    const scope = { worktreeRoot: root, projectDir: root };
    const { entries } = await scanGitChanges(scope, base, ["sub/inside"]);
    expect(byPath(entries, "link")).toMatchObject({
      base: { mode: "120000", working: Buffer.from("tree/secret") },
      current: { mode: "120000", bytes: Buffer.from(escapingLink) }, wholeEntryReason: "symlink", otherReason: null,
    });
    expect(byPath(entries, "tree/secret")).toMatchObject({ current: null, otherReason: /read safely/ });
    expect(byPath(entries, "sub")).toMatchObject({
      current: null, otherReason: /Submodule/, base: { mode: "160000", raw: null },
      status: [{ submodule: "S.M." }],
    });
    expect(byPath(entries, "sub/inside")).toMatchObject({ current: null, otherReason: /Submodule/ });
    await expect(scanGitChanges({ worktreeRoot: root, projectDir: join(root, "tree") }, base)).rejects.toThrow(/outside/);
  });

  it("keeps conflicted index stages and unsupported filename bytes without reading file content", async () => {
    const root = await fixture(format);
    await writeFile(join(root, "conflict"), "original\n");
    const base = commit(root);
    const original = git(root, ["rev-parse", "HEAD:conflict"]);
    const variant = git(root, ["hash-object", "-w", "--stdin"], Buffer.from("different\n"));
    const invalidPath = Buffer.from([0x69, 0x6e, 0xff, 0x76]);
    git(root, ["update-index", "-z", "--index-info"], Buffer.concat([
      Buffer.from(`0 ${"0".repeat(original.length)}\tconflict\0`),
      Buffer.from(`100644 ${original} 1\tconflict\0`),
      Buffer.from(`100644 ${variant} 2\tconflict\0`),
      Buffer.from(`100644 ${original} 3\tconflict\0`),
      Buffer.from(`100644 ${original}\t`), invalidPath, Buffer.from([0]),
    ]));
    await writeFile(join(root, "conflict"), "<<<<<<< conflict markers\n");
    const { entries } = await scanGitChanges({ worktreeRoot: root, projectDir: root }, base);
    const conflict = byPath(entries, "conflict");
    expect(conflict).toMatchObject({
      current: null, base: { oid: original }, otherReason: "Unmerged Git entry",
      status: [{ kind: "unmerged", xy: "UU", oids: [original, variant, original] }],
    });
    expect(entries.find((entry) => entry.pathBytes.equals(invalidPath))).toMatchObject({
      path: null, projectPath: null, current: null, otherReason: "Unsupported Git pathname",
    });
  });

  it("prechecks the disk and raw blob budgets and caps filtered base output", async () => {
    const root = await fixture(format);
    const large = GIT_SCAN_MAX_FILE_BYTES + 1;
    await writeFile(join(root, ".gitattributes"), "*.expand filter=test-expand\n");
    git(root, ["config", "filter.test-expand.smudge", `cat >/dev/null; head -c ${large} /dev/zero`]);
    await writeFile(join(root, "old-large"), "");
    await truncate(join(root, "old-large"), large);
    await writeFile(join(root, "file.expand"), "small blob\n");
    await writeFile(join(root, "limit"), "");
    await truncate(join(root, "limit"), large - 1);
    const base = commit(root);
    await unlink(join(root, "old-large"));
    await writeFile(join(root, "file.expand"), "small disk\n");
    await writeFile(join(root, "new-large"), "");
    await truncate(join(root, "new-large"), large);

    const { entries } = await scanGitChanges({ worktreeRoot: root, projectDir: root }, base, ["limit"]);
    expect(byPath(entries, "new-large")).toMatchObject({ current: null, base: null, otherReason: /Too large/ });
    expect(byPath(entries, "old-large")).toMatchObject({ current: null, base: { raw: null, working: null }, otherReason: /Too large/ });
    expect(byPath(entries, "file.expand")).toMatchObject({
      current: { bytes: Buffer.from("small disk\n") }, base: { raw: Buffer.from("small blob\n"), working: null },
      otherReason: /Too large/,
    });
    const atLimit = byPath(entries, "limit");
    expect(atLimit.otherReason).toBeNull();
    expect(atLimit.base?.raw?.length).toBe(large - 1);
    expect(atLimit.current?.bytes.length).toBe(large - 1);
  });

  it("matches case-only renames and Git's spelling of a decomposed project folder", async () => {
    const root = await fixture(format);
    const physicalName = "fólder".normalize("NFD");
    const projectDir = join(root, physicalName);
    await mkdir(projectDir);
    await writeFile(join(projectDir, "File"), "contents\n");
    await symlink("File", join(projectDir, "Link"));
    const base = commit(root);
    const prefix = git(projectDir, ["rev-parse", "--show-prefix"]);
    git(root, ["mv", "--", `${prefix}File`, `${prefix}file`]);
    git(root, ["mv", "--", `${prefix}Link`, `${prefix}link`]);

    const { entries } = await scanGitChanges({ worktreeRoot: root, projectDir }, base);
    expect(byPath(entries, `${prefix}File`)).toMatchObject({
      base: { working: Buffer.from("contents\n") }, current: null, wholeEntryReason: "rename", otherReason: null,
    });
    expect(byPath(entries, `${prefix}file`)).toMatchObject({
      base: null, current: { bytes: Buffer.from("contents\n") }, wholeEntryReason: "rename", otherReason: null,
    });
    expect(byPath(entries, `${prefix}Link`)).toMatchObject({
      base: { mode: "120000" }, current: null, wholeEntryReason: "rename", otherReason: null,
    });
    expect(byPath(entries, `${prefix}link`)).toMatchObject({
      base: null, current: { mode: "120000", bytes: Buffer.from("File") }, wholeEntryReason: "rename", otherReason: null,
    });
  });

  it("keeps cross-scope moves as scoped adds or deletions", async () => {
    const root = await fixture(format);
    const projectDir = join(root, "project");
    await mkdir(projectDir);
    await writeFile(join(projectDir, "from"), "going outside\n");
    await writeFile(join(root, "outside"), "going in\n");
    const base = commit(root);
    await rename(join(projectDir, "from"), join(root, "to-outside"));
    await rename(join(root, "outside"), join(projectDir, "to"));
    git(root, ["add", "-A"]);
    const { entries } = await scanGitChanges({ worktreeRoot: root, projectDir }, base);
    expect(entries.map((entry) => entry.path).sort()).toEqual(["project/from", "project/to"]);
    expect(byPath(entries, "project/from")).toMatchObject({ current: null, base: { working: Buffer.from("going outside\n") } });
    expect(byPath(entries, "project/to")).toMatchObject({ current: { bytes: Buffer.from("going in\n") }, base: null });
  });
});
