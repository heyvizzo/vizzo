import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteTraces, pruneTraces, recordTrace, traceFiles, traceStatus } from "./traceStore.ts";
import { tracer } from "./orchestrators/trace.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vizzo-traces-")); vi.stubEnv("VIZZO_TRACE_DIR", dir); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const prompt = { target: "solver" as const, model: "m", system: [], messages: [{ role: "user" as const, text: "hi" }] };

describe("trace store", () => {
  it("appends versioned JSON lines to a file per day, prompt and response paired by callId", () => {
    const at = new Date("2026-11-12T10:00:00Z");
    recordTrace({ kind: "prompt", turnId: "t1", callId: "c1", prompt }, at);
    recordTrace({ kind: "response", turnId: "t1", callId: "c1", response: { target: "solver", durationMs: 5 } }, at);
    const lines = readFileSync(join(dir, "2026-11-12.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.v, l.kind, l.callId])).toEqual([[1, "prompt", "c1"], [1, "response", "c1"]]);
    expect(lines[0].at).toBe("2026-11-12T10:00:00.000Z");
  });

  it("the tracer saves only while capture is on; the client gets every call either way", () => {
    const sent: unknown[] = [];
    tracer((m) => sent.push(m), "t1", undefined, false)().onPrompt(prompt);
    expect(traceFiles()).toEqual([]);
    tracer((m) => sent.push(m), "t2", "job1", true)().onPrompt(prompt);
    expect(sent).toHaveLength(2);
    const [rec] = readFileSync(traceFiles()[0]!.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rec).toMatchObject({ kind: "prompt", turnId: "t2", jobId: "job1" });
  });

  it("retention: older than the day limit goes, then the oldest until under the size limit; today stays", () => {
    for (const d of ["2026-11-01", "2026-11-08", "2026-11-10", "2026-11-12"]) writeFileSync(join(dir, `${d}.jsonl`), "x".repeat(100));
    writeFileSync(join(dir, "notes.txt"), "not a trace");
    const removed = pruneTraces(new Date("2026-11-12T12:00:00Z"), dir, 7, 150);
    expect(removed).toEqual(["2026-11-01.jsonl", "2026-11-08.jsonl", "2026-11-10.jsonl"]);
    expect(traceFiles(dir).map((f) => f.name)).toEqual(["2026-11-12.jsonl"]);
    expect(traceStatus(dir)).toMatchObject({ bytes: 100, maxDays: 7 });
  });

  it("delete all removes the trace files only", () => {
    writeFileSync(join(dir, "2026-11-12.jsonl"), "{}\n");
    writeFileSync(join(dir, "notes.txt"), "keep");
    expect(deleteTraces(dir)).toBe(1);
    expect(traceFiles(dir)).toEqual([]);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("keep");
  });
});
