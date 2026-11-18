// Two fake thread executions share a file in an isolated repository and settings directory.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChangesService } from "../server/changes/changesService.ts";
import { changeWriterId } from "../server/changes/components.ts";
import { LedgerWorkerClient } from "../server/changes/ledgerWorkerClient.ts";
import { WriterRegistry } from "../server/changes/writers.ts";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}
Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" });

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "vizzo-smoke-source-control-")));
const root = join(sandbox, "project");
const ledger = new LedgerWorkerClient(join(sandbox, "settings", "ledger.json"));
const writers = new WriterRegistry(ledger);
const service = new ChangesService(ledger, writers);
const { scanner } = service;
const path = join(root, "shared.txt");
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 });
const base = "left\nuntouched one\nuntouched two\nright\n";
const onlyA = base.replace("left", "LEFT");
const both = onlyA.replace("right", "RIGHT");

try {
  mkdirSync(root);
  git("init", "-q", "--template=", "-b", "main");
  git("config", "user.name", "Vizzo Smoke");
  git("config", "user.email", "vizzo@example.invalid");
  writeFileSync(path, base);
  git("add", "shared.txt");
  git("commit", "-qm", "Base");

  await service.restore();
  const { project, reason } = await ledger.discover(root);
  assert.ok(project, reason ?? "Could not discover the smoke repository");
  const fakeEdit = async (id: string, from: string, to: string) => {
    const writer = writers.queue({ writer: { kind: "thread", id }, title: id,
      request: "Edit a line", folder: root, purpose: "request", harness: "codex" });
    await writer.run(async () => {
      writeFileSync(path, to);
      writer.edits(id, "edit", [{ path, from, to }]);
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      const snapshot = await writers.snapshot(project.id);
      if (snapshot.executions.some(({ executionId, phase }) => executionId === writer.id && phase === "settled")) return;
      await delay(10);
    }
    throw new Error(`Fake writer ${id} did not settle`);
  };
  await fakeEdit("A", base, onlyA);
  await fakeEdit("B", onlyA, both);

  const review = await scanner.reviewProject(project);
  const groupA = review.view.groups.find(({ writer }) => writer.id === "A");
  assert.ok(groupA);
  assert.equal(groupA.own.length, 1);
  const writerId = changeWriterId(groupA.writer);
  const result = await service.commit(project, {
    jobId: "smoke-A", projectId: project.id, generation: review.view.generation, componentIds: groupA.own,
    writerIds: [writerId], selection: { kind: "writer", writerId }, message: "Commit writer A",
  }, review.scanAndFreeze);
  assert.equal(result.status, "done", JSON.stringify(result));
  assert.equal(git("rev-parse", "HEAD").trim(), result.commit);
  assert.equal(git("show", `${result.commit}:shared.txt`), onlyA);
  assert.equal(git("show", ":shared.txt"), onlyA);
  assert.deepEqual(readFileSync(path), Buffer.from(both));
  const remaining = await scanner.reviewProject(project);
  assert.deepEqual(remaining.view.groups.map(({ writer }) => writer.id), ["B"]);
  assert.equal(remaining.view.groups[0]?.own.length, 1);
  assert.equal(remaining.view.components.length, 1);
  assert.equal(remaining.view.components[0]?.other, false);
  console.log("Source-control smoke passed. Commit and index contain A. Working bytes and B’s ownership survived.");
} finally {
  try { await ledger.close(); }
  finally { rmSync(sandbox, { recursive: true, force: true }); }
}
