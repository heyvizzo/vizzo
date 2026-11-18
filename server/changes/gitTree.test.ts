import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCommitTree, prepareIndexBytes, type FrozenGitEntry } from "./gitTree.ts";

let temp: string;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "vizzo-git-tree-test-"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(temp, "missing-global-config"));
  vi.stubEnv("GIT_ATTR_NOSYSTEM", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(temp, { recursive: true, force: true });
});

function repository(format: "files" | "reftable", objectFormat: "sha1" | "sha256" = "sha1") {
  const root = join(temp, "project root");
  const indexPath = join(root, ".git", "index");
  const lockPath = `${indexPath}.lock`;
  mkdirSync(root);
  function git(args: string[], input?: string | Buffer, index?: string): Buffer {
    return execFileSync("git", args, {
      cwd: root, input, env: index ? { ...process.env, GIT_INDEX_FILE: index } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  function line(...args: string[]): string { return git(args).toString("utf8").trim(); }
  function file(path: string, content: string | Buffer): void {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  function commitBase(): string {
    git(["add", "."]);
    git(["commit", "--allow-empty", "-qm", "Fixture base"]);
    return line("rev-parse", "HEAD");
  }
  function lock(): void {
    writeFileSync(lockPath, "held by caller", { flag: "wx" });
  }
  function staged(bytes: Buffer, ...args: string[]): string {
    const path = join(temp, "prepared.index");
    writeFileSync(path, bytes);
    return git(args, undefined, path).toString("utf8");
  }
  function blob(oid: string, path: string): Buffer {
    return git(["cat-file", "blob", `${oid}:${path}`]);
  }

  git(["init", "-q", "--template=", "--initial-branch=main", `--ref-format=${format}`, `--object-format=${objectFormat}`]);
  git(["config", "user.name", "Fixture Name"]);
  git(["config", "user.email", "fixture@example.test"]);
  git(["config", "core.autocrlf", "false"]);

  return { root, indexPath, lockPath, git, line, file, commitBase, lock, staged, blob };
}

function entries(path: string, body: Buffer | string, kind: "partial" | "whole" = "whole"): FrozenGitEntry {
  return { path, content: Buffer.from(body), mode: "100644", kind };
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function configuredFilter(repo: ReturnType<typeof repository>, name: string, source: string): void {
  const fixture = join(temp, `git-tree-${name}.cjs`);
  writeFileSync(fixture, source);
  repo.git(["config", `filter.${name}.clean`, `${shellQuote(process.execPath)} ${shellQuote(fixture)}`]);
  repo.git(["config", `filter.${name}.required`, "true"]);
}

const passInput = `const fs = require("node:fs"); const input = fs.readFileSync(0);`;

describe.each(["files", "reftable"] as const)("Git tree and index with %s refs", (format) => {
  it.each([false, true])("keeps other edits and staging with split index %s", async (split) => {
    const repo = repository(format);
    if (split) repo.git(["config", "core.splitIndex", "true"]);
    else repo.git(["config", "index.skipHash", "true"]);
    const path = "selection\twith\nseparator.txt";
    const original = "start\nold first\ncontext\nold second\n";
    const partial = "start\nselected first\ncontext\nold second\n";
    const working = "start\nselected first\ncontext\nother second\n";
    repo.file(path, original);
    repo.file("other staged.txt", "unmodified\n");
    repo.file("assume.txt", "assumed\n");
    repo.file("skip.txt", "skipped\n");
    const base = repo.commitBase();
    repo.file(path, working);
    repo.file("other staged.txt", "staged by user\n");
    repo.git(["add", "other staged.txt"]);
    repo.git(["update-index", "--assume-unchanged", "assume.txt"]);
    repo.git(["update-index", "--skip-worktree", "skip.txt"]);
    if (split) repo.git(["config", "index.skipHash", "true"]);
    const indexBefore = readFileSync(repo.indexPath);
    const otherBefore = repo.line("ls-files", "--stage", "--", "other staged.txt");
    repo.lock();

    const built = await buildCommitTree({ ...repo, base, entries: [entries(path, partial, "partial")], message: "Only one line" });
    expect(repo.blob(built.commit, path).toString()).toBe(partial);
    expect(repo.blob(built.commit, "other staged.txt").toString()).toBe("unmodified\n");
    expect(repo.line("rev-parse", `${built.commit}^1`)).toBe(base);
    expect(repo.line("show", "-s", "--format=%an <%ae>|%cn <%ce>|%B", built.commit))
      .toBe("Fixture Name <fixture@example.test>|Fixture Name <fixture@example.test>|Only one line");

    const prepared = await prepareIndexBytes({ ...repo, entries: built.entries });
    expect(prepared.subarray(0, 4).toString("ascii")).toBe("DIRC");
    expect(prepared.subarray(-20)).toEqual(createHash("sha1").update(prepared.subarray(0, -20)).digest());
    expect(repo.staged(prepared, "ls-files", "-v", "--", "assume.txt", "skip.txt")).toBe("h assume.txt\nS skip.txt\n");
    expect(repo.staged(prepared, "ls-files", "--stage", "--", "other staged.txt").trim()).toBe(otherBefore);
    expect(repo.staged(prepared, "show", `:${path}`)).toBe(partial);
    expect(readFileSync(repo.indexPath)).toEqual(indexBefore);
    expect(readFileSync(repo.lockPath, "utf8")).toBe("held by caller");
    expect(readFileSync(join(repo.root, path), "utf8")).toBe(working);
    expect(repo.line("rev-parse", "HEAD")).toBe(base);
  });

  it("refuses selected staging both before building and when preparing recovered bytes", async () => {
    const repo = repository(format);
    repo.file("text.txt", "base\n");
    const base = repo.commitBase();
    const frozen = [entries("text.txt", "selected\n", "partial")];
    repo.lock();
    const built = await buildCommitTree({ ...repo, base, entries: frozen, message: "First build" });
    rmSync(repo.lockPath);
    repo.file("text.txt", "user\n");
    repo.git(["add", "text.txt"]);
    const indexBefore = readFileSync(repo.indexPath);
    repo.lock();
    await expect(buildCommitTree({ ...repo, base, entries: frozen, message: "Retry" }))
      .rejects.toThrow('This path has staged changes: "text.txt"');
    await expect(prepareIndexBytes({ ...repo, entries: built.entries }))
      .rejects.toThrow('This path has staged changes: "text.txt"');
    expect(readFileSync(repo.indexPath)).toEqual(indexBefore);
  });

  it("builds an unborn SHA-256 commit and future index without changing any ref", async () => {
    const repo = repository(format, "sha256");
    repo.lock();
    const built = await buildCommitTree({ ...repo, base: null, entries: [entries("first.txt", "")], message: "First" });
    expect(repo.line("rev-list", "--parents", "-n", "1", built.commit)).toBe(built.commit);
    expect(built.commit).toMatch(/^[a-f0-9]{64}$/);
    expect(built.entries[0]?.base).toBeNull();
    const index = await prepareIndexBytes({ ...repo, entries: built.entries });
    expect(index.subarray(-32)).toEqual(createHash("sha256").update(index.subarray(0, -32)).digest());
    expect(repo.staged(index, "ls-files")).toBe("first.txt\n");
    expect(existsSync(repo.indexPath)).toBe(false);
    expect(repo.line("for-each-ref", "--format=%(refname)")).toBe("");
  });

  it("uses attributes from the candidate parent tree through live removal and restoration", async () => {
    const repo = repository(format);
    const attrs = "child/first.dat filter=flip\nchild/text.txt text\nchild/end.dat filter=restore\n";
    const dirty = "child/first.dat -filter\nchild/text.txt -text\nchild/end.dat -filter\n";
    configuredFilter(repo, "flip", passInput + `
      if (input.toString() === ${JSON.stringify("freeze\n")}) fs.writeFileSync(".gitattributes", ${JSON.stringify(dirty)});
      process.stdout.write(input.toString().toUpperCase());
    `);
    configuredFilter(repo, "restore", passInput + `
      if (input.toString() === ${JSON.stringify("last\n")}) {
        if (fs.readFileSync(".gitattributes", "utf8") !== ${JSON.stringify(dirty)}) process.exit(3);
        fs.writeFileSync(".gitattributes", ${JSON.stringify(attrs)});
      }
      process.stdout.write(input.toString().toUpperCase());
    `);
    repo.file(".gitattributes", attrs);
    repo.file("child/first.dat", "base first\n");
    repo.file("child/text.txt", "base text\n");
    repo.file("child/end.dat", "base last\n");
    const base = repo.commitBase();
    repo.lock();

    const built = await buildCommitTree({ ...repo, base, entries: [
      entries("child/first.dat", "freeze\n"), entries("child/text.txt", "new\r\ntext\r\n"), entries("child/end.dat", "last\n"),
    ], message: "Use the parent attributes" });
    expect(repo.blob(built.tree, "child/first.dat").toString()).toBe("FREEZE\n");
    expect(repo.blob(built.tree, "child/text.txt").toString()).toBe("new\ntext\n");
    expect(repo.blob(built.tree, "child/end.dat").toString()).toBe("LAST\n");
    expect(readFileSync(join(repo.root, ".gitattributes"), "utf8")).toBe(attrs);
  });

  it("retains a base filter removed only in the working folder and applies a working-tree encoding", async () => {
    const repo = repository(format);
    configuredFilter(repo, "uppercase", passInput + "process.stdout.write(input.toString().toUpperCase());");
    repo.file(".gitattributes", "data.txt filter=uppercase\nencoded.txt working-tree-encoding=UTF-16LE\n");
    repo.file("data.txt", "old\n");
    repo.file("encoded.txt", Buffer.from("old\n", "utf16le"));
    const base = repo.commitBase();
    repo.file(".gitattributes", "data.txt -filter\nencoded.txt -working-tree-encoding\n");
    repo.lock();

    const built = await buildCommitTree({ ...repo, base, entries: [
      entries("data.txt", "new\n"), entries("encoded.txt", Buffer.from("café\n", "utf16le")),
    ], message: "Keep conversion" });
    expect(repo.blob(built.tree, "data.txt").toString()).toBe("NEW\n");
    expect(repo.blob(built.tree, "encoded.txt").toString()).toBe("café\n");
  });

  it("stabilizes CRLF attributes before using newly selected text attributes", async () => {
    const repo = repository(format);
    repo.file(".gitattributes", "*.txt -text\n");
    repo.file("text.txt", "original\n");
    const base = repo.commitBase();
    repo.lock();

    const attrs = ".gitattributes text\r\n*.txt text\r\n";
    const built = await buildCommitTree({ ...repo, base, entries: [
      entries(".gitattributes", attrs), entries("text.txt", "first\r\nsecond\r\n"),
    ], message: "Set text conversion" });
    expect(repo.blob(built.tree, ".gitattributes").toString()).toBe(".gitattributes text\n*.txt text\n");
    expect(repo.blob(built.tree, "text.txt").toString()).toBe("first\nsecond\n");
  });

  it("refuses selected attributes that cannot reproduce their own cleaned contents", async () => {
    const repo = repository(format);
    configuredFilter(repo, "flip", passInput + 'process.stdout.write(input.toString().replace("filter=flip", "filter=other"));');
    configuredFilter(repo, "other", passInput + 'process.stdout.write(input.toString().replace("filter=flip", "-filter"));');
    const base = repo.commitBase();
    repo.lock();

    await expect(buildCommitTree({ ...repo, base, entries: [
      entries(".gitattributes", ".gitattributes filter=flip\n"),
    ], message: "No stable attributes" })).rejects.toThrow(".gitattributes conversion could not be stabilized");
    expect(repo.line("rev-parse", "HEAD")).toBe(base);
  });

  it("refuses a partial selection when the selected attributes invalidate its identity conversion", async () => {
    const repo = repository(format);
    repo.file(".gitattributes", "*.txt -text\n");
    repo.file("text.txt", "old\n");
    const base = repo.commitBase();
    configuredFilter(repo, "unspecified", passInput + "process.stdout.write(input.toString().toUpperCase());");
    configuredFilter(repo, "unset", passInput + "process.stdout.write(input.toString().toLowerCase());");
    repo.lock();
    for (const attrs of ["*.txt ident\n", "*.txt text eol=crlf\n", "*.txt filter=unspecified\n", "*.txt filter=unset\n"]) {
      await expect(buildCommitTree({ ...repo, base, entries: [
        entries(".gitattributes", attrs), entries("text.txt", "selected\n", "partial"),
      ], message: "Recheck identity" })).rejects.toThrow("Changed meanwhile: review again");
    }
  });

  it("stores an LFS-compatible pointer, preserves raw binary and symlink bytes, and ignores a recreated deletion", async () => {
    const repo = repository(format);
    configuredFilter(repo, "lfs", passInput + `
      const { createHash } = require("node:crypto");
      const oid = createHash("sha256").update(input).digest("hex");
      const dir = ".git/lfs/objects/" + oid.slice(0, 2) + "/" + oid.slice(2, 4);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dir + "/" + oid, input);
      process.stdout.write(["version https://git-lfs.github.com/spec/v1", "oid sha256:" + oid, "size " + input.length, ""].join("\\n"));
    `);
    repo.file(".gitattributes", "*.lfs filter=lfs\nlink filter=lfs\n");
    repo.file("removed", "was tracked\n");
    const base = repo.commitBase();
    repo.file("removed", "recreated after the scan\n");
    symlinkSync("working-target", join(repo.root, "link"));
    repo.lock();
    const binary = Buffer.from([0, 0xff, 0x0d, 0, 0x17]);
    const oid = createHash("sha256").update(binary).digest("hex");
    const built = await buildCommitTree({ ...repo, base, entries: [
      entries("data.lfs", binary), { path: "binary", mode: "100755", kind: "whole", content: binary },
      { path: "link", mode: "120000", kind: "whole", content: Buffer.from("frozen-target") },
      { path: "removed", mode: "0", kind: "whole", content: null },
    ], message: "Other entry types" });
    expect(repo.blob(built.tree, "data.lfs").toString())
      .toBe(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 5\n`);
    expect(readFileSync(join(repo.root, ".git/lfs/objects", oid.slice(0, 2), oid.slice(2, 4), oid))).toEqual(binary);
    expect(repo.blob(built.tree, "binary")).toEqual(binary);
    expect(repo.blob(built.tree, "link").toString()).toBe("frozen-target");
    expect(repo.line("ls-tree", built.tree, "binary")).toMatch(/^100755 blob /);
    expect(repo.line("ls-tree", built.tree, "link")).toMatch(/^120000 blob /);
    expect(repo.line("ls-tree", built.tree, "removed")).toBe("");
    const index = await prepareIndexBytes({ ...repo, entries: built.entries });
    expect(repo.staged(index, "ls-files", "--", "removed")).toBe("");
    expect(readFileSync(join(repo.root, "removed"), "utf8")).toBe("recreated after the scan\n");
  });

  it("follows commit.gpgSign without running commit or fsmonitor hooks", async () => {
    const repo = repository(format);
    repo.file("text.txt", "base\n");
    const base = repo.commitBase();
    const key = join(temp, "fixture-key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { stdio: "pipe" });
    repo.git(["config", "gpg.format", "ssh"]);
    repo.git(["config", "user.signingKey", key]);
    const marker = join(temp, "hook-ran");
    const hook = join(temp, "hooks");
    mkdirSync(hook);
    for (const name of ["pre-commit", "commit-msg", "post-index-change", "fsmonitor"]) {
      writeFileSync(join(hook, name), `#!/bin/sh\nprintf invoked > ${shellQuote(marker)}\nexit 1\n`, { mode: 0o700 });
    }
    repo.git(["config", "core.hooksPath", hook]);
    repo.git(["config", "core.fsmonitor", join(hook, "fsmonitor")]);
    repo.lock();
    const frozen = [entries("text.txt", "new\n")];
    const unsigned = await buildCommitTree({ ...repo, base, entries: frozen, message: "Unsigned" });
    expect(repo.line("cat-file", "commit", unsigned.commit)).not.toContain("gpgsig");
    repo.git(["config", "commit.gpgSign", "true"]);
    const signed = await buildCommitTree({ ...repo, base, entries: frozen, message: "Signed\n\nSecond paragraph." });
    expect(repo.line("cat-file", "commit", signed.commit)).toContain("gpgsig -----BEGIN SSH SIGNATURE-----");
    expect(repo.line("show", "-s", "--format=%B", signed.commit)).toBe("Signed\n\nSecond paragraph.");
    await prepareIndexBytes({ ...repo, entries: signed.entries });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses an in-progress operation and a selected gitlink", async () => {
    const repo = repository(format);
    const initial = repo.commitBase();
    repo.git(["update-index", "--add", "--cacheinfo", `160000,${initial},submodule`]);
    repo.git(["commit", "-qm", "Gitlink fixture"]);
    const base = repo.line("rev-parse", "HEAD");
    repo.lock();
    for (const [marker, operation] of [
      ["MERGE_HEAD", "merge"],
      ["rebase-apply", "rebase"],
      ["rebase-merge", "rebase"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
      ["sequencer", "cherry-pick or revert"],
    ] as const) {
      repo.file(`.git/${marker}`, initial);
      await expect(buildCommitTree({ ...repo, base, entries: [entries("file.txt", "new")], message: "During an operation" }))
        .rejects.toThrow(`A Git ${operation} is in progress`);
      rmSync(join(repo.root, ".git", marker));
    }
    await expect(buildCommitTree({ ...repo, base, entries: [
      { path: "submodule", mode: "0", kind: "whole", content: null },
    ], message: "Remove gitlink" })).rejects.toThrow("Vizzo cannot commit a submodule path");
  });

  it("requires explicit selection of paths displaced by a file/directory change", async () => {
    const repo = repository(format);
    repo.file("docs/info.txt", "base\n");
    const base = repo.commitBase();
    repo.lock();
    const frozen = [entries("docs", "file replacing the directory\n")];
    await expect(buildCommitTree({ ...repo, base, entries: frozen, message: "Incomplete selection" }))
      .rejects.toThrow('An unselected Git entry conflicts with a selected path: "docs/info.txt"');
    const built = await buildCommitTree({ ...repo, base, entries: [
      ...frozen, { path: "docs/info.txt", mode: "0", kind: "whole", content: null },
    ], message: "Replace the directory" });
    expect(repo.blob(built.tree, "docs").toString()).toBe("file replacing the directory\n");
    const index = await prepareIndexBytes({ ...repo, entries: built.entries });
    expect(repo.staged(index, "ls-files")).toBe("docs\n");
    expect(readFileSync(join(repo.root, "docs/info.txt"), "utf8")).toBe("base\n");
  });
});
