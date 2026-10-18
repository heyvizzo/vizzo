import { describe, expect, it } from "vitest";
import { EngineHost, type HostedHelper } from "./engineHost.ts";

/** A helper whose model "loads" when the test says so. */
class FakeHelper implements HostedHelper {
  static n = 0;
  readonly pid = 1000 + ++FakeHelper.n;
  dead = false;
  killed = false;
  load!: () => void;
  fail!: (e: Error) => void;
  readonly ready = new Promise<void>((res, rej) => { this.load = res; this.fail = rej; });
  constructor() { this.ready.catch(() => {}); }
  kill(): void { this.killed = true; this.dead = true; this.fail(new Error("killed")); }
}

const setup = (spawn?: (e: "a" | "b") => Promise<FakeHelper>) => {
  const made: FakeHelper[] = [];
  const host = new EngineHost<"a" | "b", FakeHelper>("test", { a: "Engine A", b: "Engine B" }, spawn ?? (async () => { const h = new FakeHelper(); made.push(h); return h; }));
  host.log = () => {};
  return { host, made };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("EngineHost", () => {
  it("lists an engine as loading, then ready with its load time and pid", async () => {
    const { host, made } = setup();
    const started = host.start("a");
    await tick();
    expect(host.states()).toMatchObject([{ engine: "a", label: "Engine A", state: "loading", pid: made[0]!.pid }]);
    made[0]!.load();
    await started;
    expect(host.states()[0]).toMatchObject({ state: "ready", loadMs: expect.any(Number) });
  });

  it("starts one helper per engine", async () => {
    const { host, made } = setup();
    void host.start("a"); void host.start("a");
    await tick();
    made[0]!.load();
    expect(await host.get("a")).toBe(made[0]);
    expect(made).toHaveLength(1);
  });

  it("stop kills the helper at once, even while it loads, and drops it from the list", async () => {
    const { host, made } = setup();
    host.start("a").catch(() => {});
    await tick();
    host.stop("a");
    expect(made[0]!.killed).toBe(true);
    expect(host.states()).toEqual([]);
  });

  it("kills a helper that is spawned after it was stopped", async () => {
    let spawned!: (h: FakeHelper) => void;
    const { host } = setup(() => new Promise((res) => { spawned = res; }));
    host.start("a").catch(() => {});
    host.stop("a");
    const h = new FakeHelper();
    spawned(h);
    await tick();
    expect(h.killed).toBe(true);
  });

  it("keeps a failed start listed with its error, and retries on the next start", async () => {
    let fail = true;
    const { host, made } = setup(async () => { if (fail) throw new Error("not installed (run setup)"); const h = new FakeHelper(); made.push(h); return h; });
    await expect(host.start("b")).rejects.toThrow("not installed");
    expect(host.states()).toMatchObject([{ engine: "b", state: "error", error: "not installed (run setup)" }]);
    fail = false;
    const again = host.start("b");
    await tick();
    made[0]!.load();
    await again;
    expect(host.states()).toMatchObject([{ engine: "b", state: "ready" }]);
  });

  it("reports a helper that died after it was ready", async () => {
    const { host, made } = setup();
    const s = host.start("a");
    await tick();
    made[0]!.load();
    await s;
    made[0]!.dead = true;
    expect(host.states()[0]).toMatchObject({ state: "error", error: "the helper process exited" });
  });
});
