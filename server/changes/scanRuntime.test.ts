import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, truncate, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChangeGroup, ChangesView } from "../../shared/changes.ts";
import { changeWriterId } from "./components.ts";
import { runCommitTransaction, type CommitContext, type CommitRequest } from "./commitTransaction.ts";
import { MAX_FILE_BYTES, type EditChange } from "./evidence.ts";
import type { LedgerView } from "./ledger.ts";
import { LedgerWorkerClient } from "./ledgerWorkerClient.ts";
import type { LedgerProject } from "./project.ts";
import { ScanRuntime, type ScanResponse, type ScanRuntimePorts } from "./scanRuntime.ts";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }).trimEnd();
}

function result<T>(response: ScanResponse<T>): T {
  if (response.status !== 200) throw new Error(response.reason);
  return response.data;
}

function ready(runtime: ScanRuntime): { project: Readonly<LedgerProject>; view: ChangesView } {
  const state = runtime.status();
  if (state.kind !== "ready") throw new Error(JSON.stringify(state));
  return state;
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

async function fixture(format: string) {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  const folder = await realpath(await mkdtemp(join(tmpdir(), "change-scans-")));
  cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const root = join(folder, "repo");
  await mkdir(root);
  git(root, "init", "--quiet", "--initial-branch=main", `--ref-format=${format}`);
  git(root, "config", "user.name", "Vizzo Test");
  git(root, "config", "user.email", "vizzo@example.test");
  git(root, "config", "core.autocrlf", "false");
  const ledger = new LedgerWorkerClient(join(folder, "ledger.json"));
  cleanup.push(() => ledger.close());
  const tracked = new Set<string>();
  const writers: Awaited<ReturnType<ScanRuntimePorts["writers"]["snapshot"]>>["executions"][number][] = [];
  const observations: string[][] = [];
  const hooks: {
    beforeObserve?: () => Promise<void>;
    afterObserve?: (view: LedgerView) => LedgerView;
    beforeWriters?: () => Promise<void>;
    groupState?: ScanRuntimePorts["groupState"];
  } = {};
  const updated = vi.fn();
  const runtime = new ScanRuntime({
    ledger: {
      discover: (directory) => ledger.discover(directory),
      trackedPaths: async () => [...tracked],
      observe: async (project, paths) => {
        observations.push([...paths]);
        await hooks.beforeObserve?.();
        const observed = await ledger.observe(project, paths);
        return hooks.afterObserve?.(observed) ?? observed;
      },
    },
    writers: {
      snapshot: async (projectId) => {
        await hooks.beforeWriters?.();
        const { executionIds } = await ledger.pending();
        return {
          projectId,
          executions: writers.map((record) => ({ ...record, pending: executionIds.includes(record.executionId) })),
        };
      },
    },
    groupState: async (project) => (await hooks.groupState?.(project)) ?? {},
    updated,
  });
  cleanup.push(() => runtime.setVisible(false));
  let toolCall = 0;
  return {
    folder, root, runtime, updated, tracked, hooks, observations, writers,
    put: (path: string, content: string) => writeFile(join(root, path), content),
    commit: () => {
      git(root, "add", "-A");
      git(root, "commit", "--quiet", "-m", "External revision");
      return git(root, "rev-parse", "HEAD");
    },
    project: async (scope = root) => {
      const found = await ledger.discover(scope);
      if (!found.project) throw new Error(found.reason);
      return found.project;
    },
    edit: async (project: LedgerProject, id: string, changes: EditChange[]) => {
      if (!writers.some(({ executionId }) => executionId === id)) {
        writers.push({ writer: { kind: "thread", id }, title: id, executionId: id,
          phase: "settled", pending: false, outcome: "completed" });
      }
      for (const change of changes) {
        tracked.add(change.path.slice(root.length + 1));
        if ("move" in change) tracked.add(change.move.path.slice(root.length + 1));
      }
      return ledger.ingest(project, { executionId: id, sessionId: id, toolCallId: String(++toolCall),
        outcome: "completed", changes });
    },
  };
}

function request(project: Readonly<LedgerProject>, view: ChangesView, group: ChangeGroup): CommitRequest {
  return {
    jobId: "test-job", projectId: project.id, generation: view.generation, componentIds: group.own,
    writerIds: [changeWriterId(group.writer)], selection: { kind: "writer", writerId: changeWriterId(group.writer) },
    message: "Commit reviewed changes",
  };
}

function context(project: Readonly<LedgerProject>, view: ChangesView, group: ChangeGroup): CommitContext {
  if (!view.branch) throw new Error("A commit requires an attached HEAD");
  return {
    project, request: request(project, view, group), pid: process.pid,
    indexPath: join(project.gitDir, "index"), lock: { device: "1", inode: "2" },
    head: { branch: view.branch, oid: view.base },
  };
}

const BASE = "first\nsecond\nthird\nfourth\nfifth\n";
const FIRST = "owned first\nsecond\nthird\nfourth\nfifth\n";
const WITH_OTHER = "inserted above\nfirst\nsecond\nthird\nfourth\nowned fifth\n";
const LAST = "first\nsecond\nthird\nfourth\nowned fifth\n";

describe.each(["files", "reftable"])("source-control scan runtime (%s refs)", (format) => {
  it("advances generations when HEAD moves forward, back, and to a branch at the same OID", async () => {
    const { root, put, commit, project, edit, runtime, updated } = await fixture(format);
    await put("f", BASE);
    const base = commit();
    const pinned = await project();
    await put("f", FIRST);
    await edit(pinned, "A", [{ path: join(root, "f"), from: BASE, to: FIRST }]);
    await runtime.setProject(root);
    const first = ready(runtime).view;
    expect(first).toMatchObject({ changedFiles: 1, base, branch: "refs/heads/main", groups: [{ writer: { id: "A" } }] });
    const reviewed = result(runtime.reviewCurrent(pinned.id, first.generation));
    const selected = context(pinned, first, first.groups[0]!);

    // The external commit coincidentally contains the writer's exact line.
    const forward = commit();
    await runtime.refresh();
    const advanced = ready(runtime).view;
    expect(advanced).toMatchObject({ changedFiles: 0, base: forward, groups: [], components: [] });
    expect(advanced.generation).toBeGreaterThan(first.generation);
    expect(advanced.notices).toContain("HEAD moved: some changes are now marked Other");
    expect(await reviewed.scanAndFreeze(selected)).toBeNull();

    git(root, "reset", "--mixed", base);
    await runtime.refresh();
    const backward = ready(runtime).view;
    expect(backward).toMatchObject({ base, changedFiles: 1, groups: [], components: [{ other: true }] });
    expect(backward.generation).toBeGreaterThan(advanced.generation);

    git(root, "switch", "-c", "second");
    await runtime.refresh();
    const branch = ready(runtime).view;
    expect(branch).toMatchObject({ base, branch: "refs/heads/second", changedFiles: 1 });
    expect(branch.generation).toBeGreaterThan(backward.generation);
    await runtime.refresh();
    expect(ready(runtime).view).toBe(branch);
    expect(updated.mock.calls.map(([update]) => update.changedFiles)).toEqual([1, 0, 1, 1]);
  });

  it("scopes same-ID projects separately and lets pinned internal reviews outlive project switches", async () => {
    const { root, put, commit, project, edit, runtime, hooks, observations } = await fixture(format);
    const a = join(root, "a");
    const b = join(root, "b");
    await mkdir(a);
    await mkdir(b);
    await put("a/f", BASE);
    await put("b/f", BASE);
    commit();
    const [pinnedA, pinnedB] = await Promise.all([project(a), project(b)]);
    expect(pinnedA.id).toBe(pinnedB.id);
    await put("a/f", FIRST);
    await put("b/f", LAST);
    await edit(pinnedA, "A", [{ path: join(a, "f"), from: BASE, to: FIRST }]);
    await edit(pinnedB, "B", [{ path: join(b, "f"), from: BASE, to: LAST }]);
    hooks.groupState = async (pinned) => ({ closedWriters: pinned.scope === a ? [{ kind: "thread", id: "A" }] : [] });

    await runtime.setProject(a);
    const viewA = ready(runtime).view;
    expect(viewA.groups).toMatchObject([{ writer: { id: "A" }, state: "closed" }]);
    const interactive = result(runtime.reviewCurrent(pinnedA.id, viewA.generation));
    const internal = await runtime.reviewProject(pinnedA);
    expect(internal.view.groups).toMatchObject([{ writer: { id: "A" }, state: "closed" }]);
    expect(observations.at(-1)).toEqual(["a/f"]);

    const switching = runtime.setProject(b);
    expect(runtime.snapshot(pinnedA.id)).toMatchObject({ status: 409 });
    await switching;
    const viewB = ready(runtime).view;
    expect(viewB.groups).toMatchObject([{ writer: { id: "B" }, state: "open" }]);
    expect(observations.at(-1)).toEqual(["b/f"]);
    expect(runtime.diff(pinnedB.id, viewA.generation, viewA.components[0]!.id, "f")).toMatchObject({ status: 409 });
    expect(runtime.reviewCurrent(pinnedB.id, viewA.generation)).toMatchObject({ status: 409 });
    expect(await interactive.scanAndFreeze(context(pinnedA, viewA, viewA.groups[0]!))).toBeNull();
    await expect(runtime.reviewProject({ ...pinnedA, servedDir: b })).rejects.toThrow("served Git project changed");

    const selected = context(pinnedA, internal.view, internal.view.groups[0]!);
    const frozen = await internal.scanAndFreeze({ ...selected, request: {
      ...selected.request, selection: { kind: "delete", writerId: changeWriterId(internal.view.groups[0]!.writer) },
    } });
    expect(frozen?.entries).toMatchObject([{ path: "a/f", content: Buffer.from(FIRST) }]);
    expect(await internal.scanAndFreeze({ ...selected, project: { ...pinnedB, id: "another-project" } })).toBeNull();
    expect(ready(runtime).view).toBe(viewB);
    await runtime.setProject(null);
    expect(runtime.status().kind).toBe("none");
    expect(await internal.scanAndFreeze(selected)).not.toBeNull();
  });

  it("serves current diffs and refuses stale generations or different projects", async () => {
    const { root, put, commit, runtime, updated } = await fixture(format);
    await put("f", BASE);
    commit();
    await runtime.setProject(root);
    const { project, view: empty } = ready(runtime);
    expect(result(runtime.snapshot(project.id))).toBe(empty);
    expect(runtime.snapshot("wrong")).toMatchObject({ status: 409 });
    await put("f", LAST);
    await runtime.focus();
    const dirty = ready(runtime).view;
    expect(dirty.generation).toBeGreaterThan(empty.generation);
    const component = dirty.components[0]!.id;
    expect(runtime.diff(project.id, empty.generation, component, "f")).toMatchObject({ status: 409 });
    expect(runtime.diff("wrong", dirty.generation, component, "f")).toMatchObject({ status: 409 });
    expect(runtime.diff(project.id, dirty.generation, component, "wrong")).toMatchObject({ status: 404 });
    expect(result(runtime.diff(project.id, dirty.generation, component, "f"))).toMatchObject({
      generation: dirty.generation, component, path: "f", hunks: [{ other: true, after: "owned fifth\n" }],
    });
    await runtime.refresh();
    expect(ready(runtime).view.generation).toBe(dirty.generation);
    expect(updated).toHaveBeenCalledTimes(2);
  });

  it("freezes just the reviewed hunk through runCommitTransaction when a different same-file hunk appears", async () => {
    const { root, put, commit, project, edit, runtime, hooks } = await fixture(format);
    await put("f", BASE);
    commit();
    const pinned = await project();
    await put("f", LAST);
    await edit(pinned, "A", [{ path: join(root, "f"), from: BASE, to: LAST }]);
    await runtime.setProject(root);
    const first = ready(runtime).view;
    const review = result(runtime.reviewCurrent(pinned.id, first.generation));

    await put("f", WITH_OTHER);
    await runtime.refresh();
    expect(ready(runtime).view.components.map(({ other }) => other).sort()).toEqual([false, true]);
    expect(runtime.reviewCurrent(pinned.id, first.generation)).toMatchObject({ status: 409 });
    const selected = context(pinned, first, first.groups[0]!);
    await put("f", WITH_OTHER.replace("owned fifth", "changed selected line"));
    expect(await review.scanAndFreeze(selected)).toBeNull();
    await put("f", WITH_OTHER);
    expect(await runCommitTransaction(review.project, selected.request, {
      begin: async () => true, journal: async () => {}, reserveWriters: async () => () => {},
      scanAndFreeze: review.scanAndFreeze, settle: async () => {},
    })).toMatchObject({ status: "done" });
    expect(git(root, "show", "HEAD:f")).toBe(LAST.trimEnd());
    expect(await readFile(join(root, "f"), "utf8")).toBe(WITH_OTHER);

    // The durable settlement port classifies a Vizzo publication as an owned HEAD move.
    hooks.afterObserve = (observed) => ({ ...observed, headMoved: false });
    await runtime.refresh();
    expect(ready(runtime).view).toMatchObject({ base: git(root, "rev-parse", "HEAD"), notices: [] });
    expect(await review.scanAndFreeze(selected)).toBeNull();
  });

  it("rejects ownership from mixed file reads and retries a mixed HEAD read", async () => {
    const { root, put, commit, project, edit, runtime, hooks } = await fixture(format);
    await put("f", BASE);
    commit();
    const pinned = await project();
    await put("f", FIRST);
    await edit(pinned, "A", [{ path: join(root, "f"), from: BASE, to: FIRST }]);
    hooks.beforeObserve = async () => {
      hooks.beforeObserve = undefined;
      await put("f", LAST);
      await edit(pinned, "B", [{ path: join(root, "f"), from: FIRST, to: LAST }]);
    };
    await runtime.setProject(root);
    expect(ready(runtime).view).toMatchObject({
      groups: [], components: [{ other: true, selectable: false, reason: "The ledger and Git read different versions of this entry" }],
    });

    git(root, "branch", "switched");
    hooks.beforeWriters = async () => {
      hooks.beforeWriters = undefined;
      git(root, "symbolic-ref", "HEAD", "refs/heads/switched");
    };
    await runtime.refresh();
    const latest = ready(runtime).view;
    expect(latest).toMatchObject({ branch: "refs/heads/switched", groups: [{ writer: { id: "B" } }] });
    expect(latest.notices).toContain("HEAD moved: some changes are now marked Other");
  });

  it("coalesces edit, focus, and timer scans and stops polling when the window closes", async () => {
    const { root, put, commit, runtime, hooks, observations, updated } = await fixture(format);
    await put("f", BASE);
    commit();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await runtime.setProject(root);
    await runtime.setVisible(true);
    const { project } = ready(runtime);
    const before = observations.length;

    const reached = deferred();
    const resume = deferred();
    hooks.beforeObserve = async () => {
      hooks.beforeObserve = undefined;
      reached.release();
      await resume.promise;
    };
    const focused = runtime.focus();
    await reached.promise;
    for (let index = 0; index < 10; index++) runtime.ledgerChanged(project.id);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(observations).toHaveLength(before + 1);
    resume.release();
    await focused;
    expect(observations).toHaveLength(before + 2);
    expect(updated).toHaveBeenCalledTimes(1);

    await put("f", FIRST);
    const polled = deferred();
    updated.mockImplementationOnce(polled.release);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(observations).toHaveLength(before + 2);
    await vi.advanceTimersByTimeAsync(1);
    await polled.promise;
    expect(observations).toHaveLength(before + 3);
    expect(ready(runtime).view.changedFiles).toBe(1);

    await runtime.setVisible(false);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(observations).toHaveLength(before + 3);
    runtime.ledgerChanged("different-project");
    await vi.advanceTimersByTimeAsync(0);
    expect(observations).toHaveLength(before + 3);
    await runtime.focus();
    expect(observations).toHaveLength(before + 4);
  });

  it("lists untracked and oversized Other paths but does not list a tracked Git-clean normalized path", async () => {
    const { root, put, commit, project, edit, runtime, observations } = await fixture(format);
    await put(".gitattributes", "normalized text\n");
    // Commit the CRLF worktree representation so the index also records its working size.
    await put("normalized", "base\r\n");
    await put("mixed", BASE);
    commit();
    const pinned = await project();
    await put("normalized", "base\n");
    await put("normalized", "base\r\n");
    expect(git(root, "status", "--short")).not.toContain("normalized");
    await edit(pinned, "A", [{ path: join(root, "normalized"), from: "base\n", to: "base\r\n" }]);
    await put("mixed", FIRST);
    await edit(pinned, "A", [{ path: join(root, "mixed"), from: BASE, to: FIRST }]);
    await put("mixed", FIRST.replace("second", "manual second"));
    await put("untracked", "my file\n");
    await put("huge", "");
    await truncate(join(root, "huge"), MAX_FILE_BYTES + 1);
    await runtime.setProject(root);
    const { view } = ready(runtime);
    expect(view.changedFiles).toBe(3);
    expect(observations.at(-1)).toContain("normalized");
    expect(view.components.flatMap(({ files }) => files.map(({ path }) => path)).sort()).toEqual(["huge", "mixed", "untracked"]);
    expect(view.components.find(({ files }) => files[0]!.path === "huge")).toMatchObject({
      other: true, selectable: false, reason: "Too large for Vizzo to track",
    });
    expect(view.components.find(({ files }) => files[0]!.path === "untracked")).toMatchObject({ other: true, selectable: true });
    expect(view.components.find(({ files }) => files[0]!.path === "mixed")).toMatchObject({
      other: true, writers: [{ id: "A" }],
    });
  });

  it("includes an otherwise Git-clean path when both move endpoints have matching evidence", async () => {
    const { root, put, commit, project, edit, runtime } = await fixture(format);
    await put(".gitattributes", "destination text\n");
    await put("source", "source\n");
    await put("destination", "destination\r\n");
    commit();
    const pinned = await project();
    await put("destination", "destination\n");
    await unlink(join(root, "source"));
    await put("destination", "destination\r\n");
    expect(git(root, "status", "--short")).toContain("D source");
    expect(git(root, "status", "--short")).not.toContain("destination");
    expect((await edit(pinned, "A", [{
      path: join(root, "source"), from: "source\n", to: null,
      move: { path: join(root, "destination"), from: "destination\n", to: "destination\r\n" },
    }])).results).toEqual(["applied"]);
    await runtime.setProject(root);
    expect(ready(runtime).view).toMatchObject({
      changedFiles: 2, components: [{ other: false, writers: [{ id: "A" }], files: [
        { path: "destination", entry: "move" }, { path: "source", entry: "move" },
      ] }],
    });
  });

  it("reports a non-repository directory and shows detached changes as blocked", async () => {
    const { folder, root, put, commit, runtime } = await fixture(format);
    await runtime.setProject(folder);
    expect(runtime.status()).toMatchObject({ kind: "unavailable", reason: "The project folder is not in a Git worktree" });
    await put("f", BASE);
    const base = commit();
    git(root, "switch", "--detach", base);
    await put("f", FIRST);
    await runtime.setProject(root);
    expect(ready(runtime).view).toMatchObject({
      base, branch: null, changedFiles: 1, components: [{ other: true, selectable: false, reason: "HEAD is detached" }],
    });
  });
});
