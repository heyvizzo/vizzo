import { describe, expect, it } from "vitest";
import { parsePs, sampleMemory, treeBytes } from "./memory.ts";

describe("memory", () => {
  const procs = parsePs(" 1 0 100\n 10 1 200\n 11 10 300\n 12 11 50\n 20 1 1000\n garbage\n");

  it("parses ps (rss KiB → bytes)", () => {
    expect(procs.get(11)).toEqual({ ppid: 10, rssBytes: 300 * 1024 });
    expect(procs.size).toBe(5);
  });

  it("sums a process and its descendants", () => {
    expect(treeBytes(procs, 10)).toBe((200 + 300 + 50) * 1024);
    expect(treeBytes(procs, 20)).toBe(1000 * 1024);
    expect(treeBytes(procs, 99)).toBe(0);
  });

  it("counts a process's footprint where known (GPU memory included), else its RSS", () => {
    expect(treeBytes(procs, 10, new Map([[11, 5_000_000]]))).toBe(200 * 1024 + 5_000_000 + 50 * 1024);
  });

  it("samples this process", async () => {
    const m = await sampleMemory();
    expect(m.serverBytes).toBeGreaterThan(0);
    expect(m.totalBytes).toBeGreaterThan(0);
  });
});
