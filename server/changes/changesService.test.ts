import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ChangesService } from "./changesService.ts";
import type { CommitRequest } from "./commitTransaction.ts";
import { changeWriterId } from "./components.ts";
import { LedgerWorkerClient } from "./ledgerWorkerClient.ts";
import type { ScanReview } from "./scanRuntime.ts";
import { WriterRegistry } from "./writers.ts";

const base = "one\nblank a\ntwo\nblank b\nthree\nblank c\nfour\n";
const onlyA = base.replace("one", "ONE");
const withB = onlyA.replace("four", "FOUR");
const withOther = withB.replace("two", "TWO");
const withLateWrite = withOther.replace("three", "THREE");
const selectedPath = "old/shared.txt";
const otherPath = "current/unrelated.txt";
const directories: string[] = [];
const clients = new Set<LedgerWorkerClient>();

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close()));
  clients.clear();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function cleanGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
}

async function repository(format: "files" | "reftable") {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "vizzo-changes-service-")));
  directories.push(sandbox);
  const root = join(sandbox, "repo");
  const journal = join(sandbox, "settings", "ledger.json");
  const old = join(root, "old");
  const current = join(root, "current");
  mkdirSync(old, { recursive: true });
  mkdirSync(current);
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: root, env: cleanGitEnvironment(), encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
  const put = (path: string, bytes: string) => writeFileSync(join(root, path), bytes);
  git("init", "-q", "--template=", "-b", "main", `--ref-format=${format}`);
  git("config", "user.name", "Vizzo");
  git("config", "user.email", "vizzo@example.invalid");
  put(selectedPath, base);
  put(otherPath, "outside\n");
  put("current/flag.txt", "flag\n");
  git("add", ".");
  git("commit", "-qm", "Base");
  const originalHead = git("rev-parse", "HEAD").trim();

  function connect() {
    const ledger = new LedgerWorkerClient(journal);
    clients.add(ledger);
    const writers = new WriterRegistry(ledger);
    const service = new ChangesService(ledger, writers);
    return { ledger, writers, service, scanner: service.scanner, close: async () => {
      await ledger.close();
      clients.delete(ledger);
    } };
  }

  const session = connect();
  await session.service.restore();
  const discovered = await session.ledger.discover(old);
  if (!discovered.project) throw new Error(discovered.reason);
  const project = discovered.project;
  const queueWriter = (id: string) => session.writers.queue({
    writer: { kind: "thread", id }, title: id, request: "Edit the file", folder: old, purpose: "request", harness: "codex",
  });
  const edit = async (id: string, from: string, to: string, observed = to) => {
    const writer = queueWriter(id);
    await writer.run(async () => {
      put(selectedPath, observed);
      writer.edits(id, "edit", [{ path: join(root, selectedPath), from, to }]);
    });
    await expect.poll(async () => (await session.writers.snapshot(project.id)).executions.find(({ executionId }) =>
      executionId === writer.id)?.phase, { timeout: 10_000 }).toBe("settled");
    return writer.id;
  };
  return { ...session, connect, git, put, root, journal, old, current, project, originalHead, queueWriter, edit };
}

function requestFor(review: ScanReview, jobId = "job"): CommitRequest {
  const group = review.view.groups.find(({ writer }) => writer.id === "A");
  if (!group?.own.length) throw new Error("No selectable edits for A");
  const writerId = changeWriterId(group.writer);
  return {
    jobId, projectId: review.project.id, generation: review.view.generation,
    componentIds: group.own, writerIds: [writerId], selection: { kind: "writer", writerId }, message: "Commit A",
  };
}

function gitOwners(view: Awaited<ReturnType<LedgerWorkerClient["observe"]>>) {
  return view.files.flatMap(({ hunks }) => hunks.map(({ ownership }) => ownership.owners));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe.each(["files", "reftable"] as const)("durable Changes service on %s refs", (format) => {
  it("commits in the old scope, reserves A, and replays an independent same-file edit after its own publish", async () => {
    const repo = await repository(format);
    const a = await repo.edit("A", base, onlyA);
    const b = await repo.edit("B", onlyA, withB);
    repo.put(selectedPath, withOther);
    repo.put(otherPath, "staged by the user\n");
    repo.git("add", otherPath);
    repo.git("update-index", "--skip-worktree", "current/flag.txt");
    const originalOtherIndex = repo.git("ls-files", "-t", "--stage", "current");

    await repo.scanner.setProject(repo.current);
    const updates: string[] = [];
    const unsubscribe = repo.service.subscribe(({ kind, projectId }) => updates.push(`${kind}:${projectId}`));
    const review = await repo.scanner.reviewProject(repo.project);
    const request = requestFor(review);
    const original = repo.ledger.checkpointCommit.bind(repo.ledger);
    let repeat: Promise<void> | undefined;
    let repeatedId: string | undefined;
    let dispatched = false;
    let late: string | undefined;
    repo.ledger.checkpointCommit = async (record, proof) => {
      await original(record, proof);
      if (record.phase !== "index-ready" || record.step !== "install") return;
      expect(repo.git("rev-parse", "HEAD").trim()).toBe(record.commit);
      expect(repo.git("show", `:${selectedPath}`)).toBe(base);
      const repeated = repo.queueWriter("A");
      repeatedId = repeated.id;
      repeat = repeated.run(async () => { dispatched = true; });
      await delay(30);
      expect(dispatched).toBe(false);
      late = await repo.edit("late", withOther, withLateWrite);
      expect((await repo.writers.snapshot(repo.project.id)).executions.find(({ executionId }) => executionId === late)?.pending).toBe(true);
      expect(await repo.service.jobs(repo.project.id)).toMatchObject([{ jobId: request.jobId, status: "committing" }]);
      await expect(repo.ledger.trackedPaths(repo.project)).rejects.toThrow("settling");
      await repo.scanner.refresh();
      expect(repo.scanner.status()).toMatchObject({ kind: "unavailable", project: { id: repo.project.id, scope: repo.current } });
    };

    expect(await repo.service.commit(repo.project, request, review.scanAndFreeze)).toMatchObject({ status: "done" });
    await repeat;
    expect(dispatched).toBe(true);
    await expect.poll(async () => (await repo.writers.snapshot(repo.project.id)).executions.find(({ executionId }) =>
      executionId === repeatedId)?.phase, { timeout: 10_000 }).toBe("settled");
    expect(repo.git("show", `HEAD:${selectedPath}`)).toBe(onlyA);
    expect(repo.git("show", `:${selectedPath}`)).toBe(onlyA);
    expect(repo.git("ls-files", "-t", "--stage", "current")).toBe(originalOtherIndex);
    expect(readFileSync(join(repo.root, selectedPath), "utf8")).toBe(withLateWrite);
    const ledger = await repo.ledger.observe(repo.project, [selectedPath]);
    expect(ledger.headMoved).toBe(false);
    expect(gitOwners(ledger)).toEqual([[null], [late], [b]]);
    expect(gitOwners(ledger).flat()).not.toContain(a);
    expect(await repo.ledger.trackedPaths(repo.project)).toEqual([selectedPath]);
    expect(await repo.ledger.trackedPaths((await repo.ledger.discover(repo.current)).project!)).toEqual([otherPath]);
    const job = await repo.ledger.commitJob({ projectId: repo.project.id, jobId: request.jobId });
    expect(job).toMatchObject({ version: 1, project: repo.project, journal: { phase: "done" } });
    expect(job?.pin).toBeUndefined();
    expect(job?.prepared).toBeUndefined();
    await repo.scanner.refresh();
    expect(repo.scanner.status()).toMatchObject({ kind: "ready", project: { id: repo.project.id, scope: repo.current } });
    expect(updates).toContain(`ledger:${repo.project.id}`);
    expect(updates).toContain(`scan:${repo.project.id}`);
    unsubscribe();
  }, 90_000);

  it("replays held edits with an external HEAD before refusing publication", async () => {
    const repo = await repository(format);
    const a = await repo.edit("A", base, onlyA);
    const review = await repo.scanner.reviewProject(repo.project);
    const original = repo.ledger.checkpointCommit.bind(repo.ledger);
    let b: string | undefined;
    repo.ledger.checkpointCommit = async (record, proof) => {
      await original(record, proof);
      if (record.phase !== "publishing" || record.step !== "prepare-ref") return;
      const moved = repo.git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "External commit").trim();
      repo.git("update-ref", "HEAD", moved);
      b = await repo.edit("B", onlyA, withB);
    };

    const beforeIndex = readFileSync(join(repo.project.gitDir, "index"));
    expect(await repo.service.commit(repo.project, requestFor(review), review.scanAndFreeze)).toMatchObject({
      status: "refused", reason: expect.stringContaining("HEAD moved"),
    });
    expect(readFileSync(join(repo.project.gitDir, "index"))).toEqual(beforeIndex);
    const ledger = await repo.ledger.observe(repo.project, [selectedPath]);
    expect(ledger.headMoved).toBe(true);
    expect(gitOwners(ledger)).toEqual([[a], [b]]);
    expect(await repo.ledger.pending()).toMatchObject({ executionIds: [] });
  }, 90_000);
});

it("claims a durable queued job only with the exact request and refuses duplicate retries", async () => {
  const repo = await repository("files");
  await repo.edit("A", base, onlyA);
  const review = await repo.scanner.reviewProject(repo.project);
  const request = requestFor(review);
  expect(await repo.service.enqueue(repo.project, request)).toBe(true);
  expect(await repo.service.enqueue(repo.project, request)).toBe(false);
  expect(await repo.service.commit(repo.project, { ...request, message: "Unrelated" }, review.scanAndFreeze))
    .toMatchObject({ status: "refused", code: "duplicate-job" });
  expect(await repo.service.jobs(repo.project.id)).toMatchObject([{ jobId: request.jobId, status: "queued" }]);
  expect(await repo.service.commit(repo.project, request, review.scanAndFreeze)).toMatchObject({ status: "done" });
  expect(await repo.service.commit(repo.project, request, review.scanAndFreeze))
    .toMatchObject({ status: "refused", code: "duplicate-job" });
  expect(repo.git("rev-list", "--count", "HEAD").trim()).toBe("2");
});

it.each([
  { format: "files", exact: true },
  { format: "reftable", exact: true },
  { format: "files", exact: false },
  { format: "reftable", exact: false },
] as const)("keeps the original preimage proof for a held patch ($format, $exact)", async ({ format, exact }) => {
  const repo = await repository(format);
  await repo.edit("A", base, onlyA);
  const b = repo.queueWriter("B");
  const wrote = deferred();
  const report = deferred();
  const changes = [{
    path: join(repo.root, selectedPath),
    patch: exact
      ? "@@ -1,5 +1,5 @@\n ONE\n blank a\n two\n blank b\n-three\n+THREE\n"
      : "@@ -5 +5 @@\n-three\n+THREE\n",
  }];
  const run = b.run(async () => {
    repo.put(selectedPath, onlyA.replace("three", "THREE"));
    wrote.resolve();
    await report.promise;
    b.edits("B", "delayed", changes);
  });
  await wrote.promise;
  const review = await repo.scanner.reviewProject(repo.project);
  expect(review.view.components).toEqual(expect.arrayContaining([expect.objectContaining({ other: true })]));
  const checkpoint = repo.ledger.checkpointCommit.bind(repo.ledger);
  repo.ledger.checkpointCommit = async (record, proof) => {
    await checkpoint(record, proof);
    if (record.phase !== "publishing" || record.step !== "prepare-ref") return;
    report.resolve();
    await run;
    await expect.poll(async () => (await repo.writers.snapshot(repo.project.id)).executions.find(({ executionId }) =>
      executionId === b.id), { timeout: 10_000 }).toMatchObject({ phase: "settled", pending: true });
  };
  try {
    expect(await repo.service.commit(repo.project, requestFor(review), review.scanAndFreeze)).toMatchObject({ status: "done" });
    expect(repo.git("show", `HEAD:${selectedPath}`)).toBe(onlyA);
    expect(gitOwners(await repo.ledger.observe(repo.project, [selectedPath]))).toEqual([[exact ? b.id : null]]);
    const receipt = await repo.ledger.ingest(repo.project, {
      executionId: b.id, sessionId: "B", toolCallId: "delayed", outcome: "completed", changes,
    });
    expect(receipt.duplicate).toBe(true);
    expect(receipt.results).toEqual([exact ? "applied" : "rejected"]);
    if (!exact) expect(receipt.reason).toBe("Patch matches more than one recorded preimage");
  } finally {
    report.resolve();
    await run;
  }
}, 90_000);

it.each([
  { format: "files", witness: true, earlier: false },
  { format: "reftable", witness: true, earlier: false },
  { format: "files", witness: false, earlier: false },
  { format: "files", witness: true, earlier: true },
  { format: "reftable", witness: true, earlier: true },
] as const)("keeps an unexplained rollback Other and requires a disk witness ($format, $witness, $earlier)", async ({ format, witness, earlier }) => {
  const repo = await repository(format);
  await repo.edit("A", base, onlyA);
  const review = await repo.scanner.reviewProject(repo.project);
  const after = base.replace("three", "THREE");
  const onDisk = witness ? after : base.replace("three", "manual");
  const checkpoint = repo.ledger.checkpointCommit.bind(repo.ledger);
  let b: string | undefined;
  repo.ledger.checkpointCommit = async (record, proof) => {
    await checkpoint(record, proof);
    if (record.phase !== "index-ready" || record.step !== "install") return;
    if (earlier) await repo.edit("earlier", onlyA, withB);
    repo.put(selectedPath, base);
    b = await repo.edit("B", base, after, onDisk);
  };
  expect(await repo.service.commit(repo.project, requestFor(review), review.scanAndFreeze)).toMatchObject({ status: "done" });
  expect(repo.git("show", `HEAD:${selectedPath}`)).toBe(onlyA);
  expect(repo.git("show", `:${selectedPath}`)).toBe(onlyA);
  expect(readFileSync(join(repo.root, selectedPath), "utf8")).toBe(onDisk);
  expect(gitOwners(await repo.ledger.observe(repo.project, [selectedPath]))).toEqual([[null], [witness ? b : null]]);
}, 90_000);

it("gates a competing voice process before recovery or observation", async () => {
  const repo = await repository("files");
  await repo.edit("A", base, onlyA);
  const review = await repo.scanner.reviewProject(repo.project);
  expect(await repo.service.enqueue(repo.project, requestFor(review))).toBe(true);
  const before = readFileSync(repo.journal);
  const script = join(dirname(repo.root), "competing.mjs");
  writeFileSync(script, `
    import assert from "node:assert/strict";
    import { ChangesService } from ${JSON.stringify(new URL("./changesService.ts", import.meta.url).href)};
    import { LedgerWorkerClient } from ${JSON.stringify(new URL("./ledgerWorkerClient.ts", import.meta.url).href)};
    import { WriterRegistry } from ${JSON.stringify(new URL("./writers.ts", import.meta.url).href)};
    const [journal, project] = process.argv.slice(2);
    const ledger = new LedgerWorkerClient(journal);
    const service = new ChangesService(ledger, new WriterRegistry(ledger));
    try {
      await assert.rejects(service.restore(), { code: "LEDGER_LEASE_REFUSED" });
      await service.scanner.setProject(project);
      assert.equal(service.scanner.status().kind, "unavailable");
      assert.match(service.scanner.status().reason, /Another Vizzo process/);
      await assert.rejects(ledger.commitJobs(), { code: "LEDGER_LEASE_REFUSED" });
    } finally { await ledger.close(); }
  `);
  execFileSync(process.execPath, ["--import", "tsx", script, repo.journal, repo.old], {
    cwd: process.cwd(), env: cleanGitEnvironment(), encoding: "utf8", timeout: 60_000,
  });
  expect(readFileSync(repo.journal)).toEqual(before);
  expect(await repo.service.jobs(repo.project.id)).toMatchObject([{ jobId: "job", status: "queued" }]);
}, 90_000);

const crashScript = String.raw`
  import { writeFileSync } from "node:fs";
  import { join } from "node:path";
  import { pathToFileURL } from "node:url";
  const load = (name) => import(pathToFileURL(join(process.cwd(), "server", "changes", name + ".ts")).href);
  const { ChangesService } = await load("changesService");
  const { changeWriterId } = await load("components");
  const { LedgerWorkerClient } = await load("ledgerWorkerClient");
  const { WriterRegistry } = await load("writers");
  const [journal, old, phase, step, before, after] = process.argv.slice(2);
  const ledger = new LedgerWorkerClient(journal);
  const writers = new WriterRegistry(ledger);
  const service = new ChangesService(ledger, writers);
  await service.restore();
  const { project } = await ledger.discover(old);
  const review = await service.scanner.reviewProject(project);
  const group = review.view.groups.find(({ writer }) => writer.id === "A");
  const writerId = changeWriterId(group.writer);
  const request = {
    jobId: "interrupted", projectId: project.id, generation: review.view.generation,
    componentIds: group.own, writerIds: [writerId], selection: { kind: "writer", writerId }, message: "Commit A",
  };
  const checkpoint = ledger.checkpointCommit.bind(ledger);
  ledger.checkpointCommit = async (record, proof) => {
    const beforeSettlement = record.phase === phase && phase === "done";
    if (!beforeSettlement) await checkpoint(record, proof);
    if (!beforeSettlement && (record.phase !== phase || record.step !== step)) return;
    const writer = writers.queue({ writer: { kind: "thread", id: "held" }, title: "held", request: "Edit",
      folder: old, purpose: "request", harness: "codex" });
    await writer.run(async () => {
      const path = join(old, "shared.txt");
      writeFileSync(path, after);
      writer.edits("held", "exact", [{ path, from: before, to: after }]);
    });
    while (!(await writers.snapshot(project.id)).executions.some(({ executionId, phase, pending }) =>
      executionId === writer.id && phase === "settled" && pending)) await new Promise((resolve) => setTimeout(resolve, 10));
    process.kill(process.pid, "SIGKILL");
  };
  const result = await service.commit(project, request, review.scanAndFreeze);
  throw new Error("Child reached the end of the commit " + JSON.stringify(result));
`;

async function interrupt(repo: Awaited<ReturnType<typeof repository>>, phase: string, step: string) {
  await repo.close();
  const script = join(dirname(repo.root), "interrupt.mjs");
  writeFileSync(script, crashScript);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import", "tsx", script, repo.journal, repo.old, phase, step, onlyA, withB,
    ], {
      cwd: process.cwd(), env: cleanGitEnvironment(), stdio: ["ignore", "ignore", "pipe"], timeout: 60_000,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
    child.once("error", reject);
    child.once("close", (code, signal) => signal === "SIGKILL"
      ? resolve() : reject(new Error(`Crash fixture exited with ${code ?? signal}\n${stderr}`)));
  });
}

describe.each(["files", "reftable"] as const)("restart from durable %s checkpoints", (format) => {
  it.each([
    { phase: "locking", step: "build-commit", status: "refused", published: false },
    { phase: "publishing", step: "prepare-ref", status: "not-published", published: false },
    { phase: "index-ready", step: "install", status: "done", published: true },
  ])("settles $phase/$step after a real process crash", async ({ phase, step, status, published }) => {
    const repo = await repository(format);
    const a = await repo.edit("A", base, onlyA);
    await interrupt(repo, phase, step);
    const restarted = repo.connect();
    expect(existsSync(join(repo.project.gitDir, "index.lock"))).toBe(true);
    const jobs = await restarted.service.jobs(repo.project.id);
    expect(jobs).toMatchObject([{ jobId: "interrupted", status }]);
    expect(existsSync(join(repo.project.gitDir, "index.lock"))).toBe(false);
    expect(repo.git("show", `HEAD:${selectedPath}`)).toBe(published ? onlyA : base);
    expect(repo.git("show", `:${selectedPath}`)).toBe(published ? onlyA : base);
    expect(readFileSync(join(repo.root, selectedPath), "utf8")).toBe(withB);
    const writers = await restarted.writers.snapshot(repo.project.id);
    const b = writers.executions.find(({ writer }) => writer.id === "held")?.executionId;
    expect(b).toBeDefined();
    expect(gitOwners(await restarted.ledger.observe(repo.project, [selectedPath]))).toEqual(published ? [[b]] : [[a], [b]]);
    expect(await restarted.service.fix(repo.project.id, "interrupted")).toMatchObject({ status: "skipped" });
  }, 90_000);

  it("retains the pin while a reset makes publication indeterminate, then retries after the commit returns", async () => {
    const repo = await repository(format);
    await repo.edit("A", base, onlyA);
    await interrupt(repo, "index-ready", "install");
    const published = repo.git("rev-parse", "HEAD").trim();
    repo.git("update-ref", "HEAD", repo.originalHead);

    const restarted = repo.connect();
    const jobs = await restarted.service.jobs(repo.project.id);
    expect(jobs).toMatchObject([{ jobId: "interrupted", status: "indeterminate", commit: published }]);
    await expect(restarted.ledger.trackedPaths(repo.project)).rejects.toThrow(/check git log/i);
    await restarted.scanner.setProject(repo.old);
    expect(restarted.scanner.status()).toMatchObject({ kind: "unavailable", project: { id: repo.project.id } });
    expect(repo.git("show", `:${selectedPath}`)).toBe(base);
    repo.git("update-ref", "HEAD", published);
    expect(await restarted.service.fix(repo.project.id, "interrupted")).toMatchObject({ status: "done" });
    expect(repo.git("show", `:${selectedPath}`)).toBe(onlyA);
    const writers = await restarted.writers.snapshot(repo.project.id);
    const b = writers.executions.find(({ writer }) => writer.id === "held")?.executionId;
    expect(gitOwners(await restarted.ledger.observe(repo.project, [selectedPath]))).toEqual([[b]]);
  }, 90_000);

  it("reports a published candidate on an advanced branch without touching the index", async () => {
    const repo = await repository(format);
    await repo.edit("A", base, onlyA);
    await interrupt(repo, "index-ready", "install");
    const published = repo.git("rev-parse", "HEAD").trim();
    const advanced = repo.git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "External advance").trim();
    repo.git("update-ref", "HEAD", advanced);
    const index = readFileSync(join(repo.project.gitDir, "index"));
    const restarted = repo.connect();
    expect(await restarted.service.jobs(repo.project.id)).toMatchObject([{
      jobId: "interrupted", status: "repair-needed", commit: published, canFix: false,
      outcome: { evidence: "published", reason: "branch-tip-changed" },
    }]);
    expect(readFileSync(join(repo.project.gitDir, "index"))).toEqual(index);
    expect(repo.git("rev-parse", "HEAD").trim()).toBe(advanced);
    await expect(restarted.ledger.trackedPaths(repo.project)).rejects.toThrow("branch tip changed");
  }, 90_000);

  it("settles ownership if the installed candidate index is intact after branch advancement", async () => {
    const repo = await repository(format);
    await repo.edit("A", base, onlyA);
    await interrupt(repo, "done", "");
    const indexPath = join(repo.project.gitDir, "index");
    expect(existsSync(indexPath + ".lock")).toBe(false);
    expect(repo.git("show", `:${selectedPath}`)).toBe(onlyA);
    const published = repo.git("rev-parse", "HEAD").trim();
    const advanced = repo.git("commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "External advance").trim();
    repo.git("update-ref", "HEAD", advanced);
    const index = readFileSync(indexPath);
    const restarted = repo.connect();
    expect(await restarted.service.jobs(repo.project.id)).toMatchObject([{
      jobId: "interrupted", status: "done", commit: published, outcome: { index: "already-current" },
    }]);
    expect(readFileSync(indexPath)).toEqual(index);
    expect(repo.git("rev-parse", "HEAD").trim()).toBe(advanced);
    const writers = await restarted.writers.snapshot(repo.project.id);
    const b = writers.executions.find(({ writer }) => writer.id === "held")?.executionId;
    expect(gitOwners(await restarted.ledger.observe(repo.project, [selectedPath]))).toEqual([[b]]);
  }, 90_000);
});
