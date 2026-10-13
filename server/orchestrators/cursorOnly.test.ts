import { ConnectionState } from "../connection.ts";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../shared/config.ts";
import type { CursorSample, ServerMsg, Word } from "../../shared/protocol.ts";
import type { OpenScribe, SttStream } from "../adapters/types.ts";
import type { TurnContext } from "./types.ts";
import { createCursorOnlyOrchestrator } from "./cursorOnly.ts";

function fakeStt(result: { text: string; words: Word[] }) {
  const pushed: Buffer[] = [];
  let partial: ((t: string) => void) | null = null;
  let resolveFinal!: (v: { text: string; words: Word[] }) => void;
  const finalP = new Promise<{ text: string; words: Word[] }>((r) => (resolveFinal = r));
  const stream: SttStream & { pushed: Buffer[]; committed: boolean; closed: boolean; emitPartial(t: string): void } = {
    pushed, committed: false, closed: false, seconds: 0,
    pushAudio: (b) => void pushed.push(b),
    commit() {
      this.committed = true;
      setTimeout(() => resolveFinal(result), 5);
    },
    onPartial: (cb) => void (partial = cb),
    final: () => finalP,
    close() { this.closed = true; },
    emitPartial: (t) => partial?.(t),
  };
  return stream;
}

const sample = (t: number, x: number, label: string): CursorSample => ({
  t, x, y: 0, scrollX: 0, scrollY: 0, elementPath: `main > div.${label}`, dataSource: `demo.html:${x}`, label,
});

function ctx(over: Partial<TurnContext> = {}) {
  const sent: ServerMsg[] = [];
  const marks: string[] = [];
  const c: TurnContext = {
    turnId: "t1",
    config: { ...DEFAULT_CONFIG, approach: "cursor-only" },
    mark: (n) => void marks.push(n),
    send: (m) => void sent.push(m),
    sendAudio: () => {},
    connection: new ConnectionState(),
    cursorSamples: () => [sample(1000, 10, "a"), sample(1100, 10, "a"), sample(1500, 300, "b"), sample(1600, 300, "b")],
    tAudioStart: () => 1000,
    ...over,
  };
  return { c, sent, marks };
}

const words: Word[] = [{ text: "Move", start: 0, end: 0.05 }, { text: "this", start: 0.1, end: 0.2 }];

describe("cursor-only orchestrator", () => {
  it("streams audio, commits on release, sends stt.final and pointing.resolved", async () => {
    const stt = fakeStt({ text: "Move this", words });
    let resolveOpen!: (s: SttStream) => void;
    const open: OpenScribe = vi.fn(() => new Promise<SttStream>((r) => (resolveOpen = r)));
    const { c, sent, marks } = ctx();
    const h = createCursorOnlyOrchestrator(open)(c);

    h.onAudio(Buffer.alloc(960)); // before Scribe is open → buffered
    resolveOpen(stt);
    await new Promise((r) => setTimeout(r, 0));
    h.onAudio(Buffer.alloc(960));
    stt.emitPartial("Move th");
    expect(stt.pushed).toHaveLength(2);
    expect(stt.committed).toBe(false);

    h.onRelease();
    const res = await h.done;
    expect(stt.committed).toBe(true);
    expect(stt.closed).toBe(true);
    expect(sent.map((m) => m.type)).toEqual(["stt.partial", "stt.final", "pointing.resolved"]);
    const pr = sent[2] as Extract<ServerMsg, { type: "pointing.resolved" }>;
    expect(pr.targets.map((t) => t.algorithm)).toEqual(["atStart", "dwell", "mode", "dwellMode"]);
    expect(pr.targets[1]!.sample!.label).toBe("a");
    expect(marks).toEqual(["pointing.resolved", "turn.end"]);
    expect(res.transcript).toBe("Move this");
    expect(res.pointing).toEqual(pr.targets);
    expect(res.usage.scribeSeconds).toBeCloseTo(0.04);
    expect(res.error).toBeUndefined();
  });

  it("uses the config window", async () => {
    const stt = fakeStt({ text: "this", words: [{ text: "this", start: 0.5, end: 0.55 }] });
    const { c, sent } = ctx({ config: { ...DEFAULT_CONFIG, approach: "cursor-only", preMs: 0, postMs: 0 } });
    const h = createCursorOnlyOrchestrator(async () => stt)(c);
    h.onRelease();
    await h.done;
    const pr = sent.find((m) => m.type === "pointing.resolved") as Extract<ServerMsg, { type: "pointing.resolved" }>;
    // window [1500, 1550] contains only the sample at 1500
    expect(pr.targets.find((t) => t.algorithm === "dwell")!.sample!.t).toBe(1500);
  });

  it("skips pointing without tAudioStart", async () => {
    const stt = fakeStt({ text: "this", words });
    const { c, sent } = ctx({ tAudioStart: () => undefined });
    const h = createCursorOnlyOrchestrator(async () => stt)(c);
    h.onRelease();
    const res = await h.done;
    expect(res.pointing).toEqual([]);
    expect(res.error).toMatch(/audioStart/);
    expect(sent.some((m) => m.type === "pointing.resolved")).toBe(true);
  });

  it("reports a Scribe open failure", async () => {
    const { c, sent } = ctx();
    const h = createCursorOnlyOrchestrator(async () => { throw new Error("no key"); })(c);
    await expect(h.done).rejects.toThrow("no key");
    expect(sent[0]).toMatchObject({ type: "error", source: "scribe" });
  });

  it("cancel closes the stream and rejects done", async () => {
    const stt = fakeStt({ text: "", words: [] });
    const { c } = ctx();
    const h = createCursorOnlyOrchestrator(async () => stt)(c);
    await new Promise((r) => setTimeout(r, 0));
    h.cancel();
    await expect(h.done).rejects.toThrow("cancelled");
    expect(stt.closed).toBe(true);
  });
});
