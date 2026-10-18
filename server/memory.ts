// RAM per element thread, per page (the client sums its threads), for the on-device speech models and for the whole
// app server. Sampled every few seconds while a page is connected, and sent to every connection. `ps` gives the
// process tree; on macOS each process counts its physical footprint (tools/memfoot, proc_pid_rusage), which includes
// GPU memory: ps RSS misses most of an MLX model (Parakeet: 42 MB RSS, 2.3 GB footprint). Elsewhere, RSS.
import { execFile } from "node:child_process";
import type { MemorySnapshot } from "../shared/protocol.ts";
import { threadStore } from "./threads/store.ts";

const SAMPLE_MS = 3000;

export interface Proc { ppid: number; rssBytes: number }

/** `ps -axo pid=,ppid=,rss=` output (rss in KiB) → pid → parent and resident bytes. */
export function parsePs(out: string): Map<number, Proc> {
  const procs = new Map<number, Proc>();
  for (const line of out.split("\n")) {
    const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(pid) && Number.isFinite(ppid) && Number.isFinite(rss)) procs.set(pid!, { ppid: ppid!, rssBytes: rss! * 1024 });
  }
  return procs;
}

/** `pid` and all its descendants that are running. */
export function treePids(procs: Map<number, Proc>, pid: number): number[] {
  const children = new Map<number, number[]>();
  for (const [p, { ppid }] of procs) children.set(ppid, [...(children.get(ppid) ?? []), p]);
  const out: number[] = [];
  const stack = [pid];
  const seen = new Set<number>();
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p) || !procs.has(p)) continue;
    seen.add(p);
    out.push(p);
    stack.push(...(children.get(p) ?? []));
  }
  return out;
}

/** Bytes of `pid` and all its descendants (0: not running): each one's footprint where known, else its RSS. */
export function treeBytes(procs: Map<number, Proc>, pid: number, footprints?: Map<number, number>): number {
  return treePids(procs, pid).reduce((n, p) => n + (footprints?.get(p) ?? procs.get(p)!.rssBytes), 0);
}

let memfoot: Promise<string | null> | null = null;

/** Physical footprint by pid (macOS; empty elsewhere or if the helper can't be built). */
export async function footprints(pids: number[]): Promise<Map<number, number>> {
  if (process.platform !== "darwin" || !pids.length) return new Map();
  memfoot ??= import("./adapters/macTts.ts").then((m) => m.buildSwiftHelper("memfoot")).catch((e) => {
    console.error(`[memory] no footprints, using RSS: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  const bin = await memfoot;
  if (!bin) return new Map();
  return new Promise((resolve) => {
    execFile(bin, pids.map(String), { maxBuffer: 1024 * 1024 }, (e, out) => {
      if (e) return resolve(new Map());
      try { resolve(new Map(Object.entries(JSON.parse(out) as Record<string, number>).map(([p, b]) => [Number(p), b]))); } catch { resolve(new Map()); }
    });
  });
}

/** Memory of these processes and their children (the speech engines' helpers, for the Settings page), by pid. */
export async function memoryOf(pids: number[]): Promise<Map<number, number>> {
  const procs = await ps();
  const fp = await footprints(pids.flatMap((p) => treePids(procs, p)));
  return new Map(pids.map((p) => [p, treeBytes(procs, p, fp)]));
}

function ps(): Promise<Map<number, Proc>> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-axo", "pid=,ppid=,rss="], { maxBuffer: 8 * 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(parsePs(out))));
  });
}

export async function sampleMemory(): Promise<MemorySnapshot> {
  const procs = await ps();
  const fp = await footprints(treePids(procs, process.pid));
  const store = threadStore();
  const threads: Record<string, number> = {};
  for (const t of store.list()) {
    const pid = store.get(t.threadId)?.handle?.pid?.();
    const bytes = pid ? treeBytes(procs, pid, fp) : 0;
    if (bytes > 0) threads[t.threadId] = bytes;
  }
  const { speechEnginePids } = await import("./speechEngines.ts");
  const speechBytes = speechEnginePids().reduce((n, p) => n + treeBytes(procs, p, fp), 0);
  return {
    totalBytes: treeBytes(procs, process.pid, fp), serverBytes: fp.get(process.pid) ?? process.memoryUsage().rss, threads,
    ...(speechBytes ? { speechBytes } : {}),
  };
}

let watching = false;

/** Start sampling (once per process); each sample goes to every connected page. */
export function watchMemory(): void {
  if (watching) return;
  watching = true;
  let busy = false;
  setInterval(() => {
    const store = threadStore();
    if (busy || !store.connected()) return;
    busy = true;
    sampleMemory()
      .then((memory) => store.broadcast({ type: "memory", memory }))
      .catch((e) => console.error("[memory] sample failed", e))
      .finally(() => { busy = false; });
  }, SAMPLE_MS).unref();
}
