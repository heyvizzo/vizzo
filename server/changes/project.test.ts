import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { discoverLedgerProject, readBaseEntry, readLedgerHead } from "./project.ts";

it("reads the exact base entry when ls-tree includes siblings of a requested descendant", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vizzo-base-ancestors-")));
  const git = (args: string[], input?: Buffer) => execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], {
    input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  try {
    git(["init", "-q", "--template=", "-b", "main"]);
    git(["config", "user.name", "Vizzo Test"]);
    git(["config", "user.email", "vizzo@example.invalid"]);
    const folder = join(root, "project");
    mkdirSync(folder);
    writeFileSync(join(folder, "a.txt"), "irrelevant sibling\n");
    writeFileSync(join(folder, "z.txt"), "reviewed file\n");
    writeFileSync(join(root, "blocking.txt"), "blob ancestor\n");
    git(["add", "."]);
    git(["commit", "-qm", "Track siblings and ancestor"]);
    const blob = git(["rev-parse", "HEAD:project/a.txt"]).trim();
    const head = git(["rev-parse", "HEAD"]).trim();
    git(["update-index", "-z", "--index-info"], Buffer.concat([
      Buffer.from(`100644 ${blob}\tproject/`), Buffer.from([0xff, 0]),
      Buffer.from(`160000 ${head}\tgitlink\0`),
    ]));
    git(["commit", "-qm", "Track non-UTF-8 sibling and gitlink"]);

    const found = discoverLedgerProject(folder);
    if (!found.project) throw new Error(found.reason);
    expect(readBaseEntry(found.project, "project/z.txt", readLedgerHead(found.project))).toEqual({
      kind: "file", mode: "100644", bytes: Buffer.from("reviewed file\n"),
    });
    const whole = discoverLedgerProject(root);
    if (!whole.project) throw new Error(whole.reason);
    const base = readLedgerHead(whole.project);
    expect(readBaseEntry(whole.project, "blocking.txt/child", base)).toEqual({ kind: "opaque", reason: "Base has a non-directory ancestor" });
    expect(readBaseEntry(whole.project, "gitlink/child", base)).toEqual({ kind: "opaque", reason: "Submodule path" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
