import { describe, expect, it } from "vitest";
import type { ServerMsg } from "../../shared/protocol.ts";
import { DEFAULT_CONFIG } from "../../shared/config.ts";
import { Floor, ttsSpeaker, type FloorLine, type LineOutcome, type Speaker } from "./floor.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Speaks `chunks` 1 KB chunks, 5 ms apart. */
const fakeSpeaker = (chunks = 3, firstMs = 5): Speaker => (_text, onAudio) => {
  let stopped = false;
  const done = (async () => {
    await wait(firstMs);
    for (let i = 0; i < chunks && !stopped; i++) { onAudio(Buffer.alloc(1024)); await wait(5); }
    return null;
  })();
  return { stop: () => { stopped = true; }, done };
};

function setup(focused: string | null = null) {
  const sent: ServerMsg[] = [];
  let bytes = 0;
  const floor = new Floor({ send: (m) => sent.push(m), sendAudio: (b) => { bytes += b.length; } }, { graceMs: 5, focused: () => focused });
  const outcomes: Record<string, LineOutcome> = {};
  const line = (sayId: string, kind: FloorLine["kind"], threadId: string | null, title?: string): FloorLine => ({
    kind, title, speaker: fakeSpeaker(), say: { sayId, threadId, text: sayId, needsReply: false },
    onDone: (o) => { outcomes[sayId] = o; },
  });
  const says = () => sent.filter((m): m is Extract<ServerMsg, { type: "thread.say" }> => m.type === "thread.say");
  return { floor, line, says, outcomes, bytes: () => bytes };
}

describe("speaking floor", () => {
  it("frames each line with thread.say start/end around its audio; one at a time", async () => {
    const s = setup();
    s.floor.enqueue(s.line("r1", "result", "A"));
    s.floor.enqueue(s.line("r2", "result", "B"));
    await wait(80);
    expect(s.says().map((m) => `${m.say.sayId}:${m.state}`)).toEqual(["r1:start", "r1:end", "r2:start", "r2:end"]);
    expect(s.bytes()).toBe(6 * 1024);
    expect(s.outcomes).toEqual({ r1: "spoken", r2: "spoken" });
  });

  it("waits for the turn to end; the focused thread's result goes first, reminders batched last", async () => {
    const s = setup("F");
    s.floor.turnStarted();
    s.floor.enqueue(s.line("rem1", "reminder", "A", "the red button"));
    s.floor.enqueue(s.line("other", "result", "B"));
    s.floor.enqueue(s.line("rem2", "reminder", "C", "the footer links"));
    s.floor.enqueue(s.line("focused", "result", "F"));
    await wait(20);
    expect(s.says()).toEqual([]);
    s.floor.turnEnded();
    await wait(150);
    const starts = s.says().filter((m) => m.state === "start");
    expect(starts.map((m) => m.say.sayId).slice(0, 2)).toEqual(["focused", "other"]);
    expect(starts).toHaveLength(3);
    expect(starts[2]!.say).toMatchObject({ threadId: null, needsReply: false, text: "The tasks on the red button and the footer links finished. Want to hear about them?" });
    expect(s.outcomes).toMatchObject({ rem1: "spoken", rem2: "spoken" });
  });

  it("a turn cuts the current line: interrupted lines are not replayed; lines with no audio yet are", async () => {
    const s = setup();
    s.floor.enqueue(s.line("a", "reminder", "A", "x"));
    await wait(12); // audio started
    s.floor.turnStarted();
    await wait(20);
    expect(s.outcomes.a).toBe("interrupted");
    expect(s.says().map((m) => m.state)).toEqual(["start", "end"]);
    s.floor.turnEnded();
    s.floor.enqueue(s.line("b", "result", "B"));
    await wait(7); // grace passed, speaker still opening
    s.floor.turnStarted();
    await wait(20);
    expect(s.outcomes.b).toBeUndefined(); // pre-empted, queued again
    s.floor.turnEnded();
    await wait(60);
    expect(s.outcomes.b).toBe("spoken");
  });

  it("drop removes a thread's queued lines and stops its current one", async () => {
    const s = setup();
    s.floor.enqueue(s.line("a", "result", "A"));
    s.floor.enqueue(s.line("a2", "result", "A"));
    s.floor.enqueue(s.line("b", "result", "B"));
    await wait(12);
    s.floor.drop("A");
    await wait(60);
    expect(s.outcomes).toEqual({ a: "interrupted", b: "spoken" });
  });
});

describe("ttsSpeaker", () => {
  it("silent config (a typed comment's run): opens no TTS, the line is still shown", async () => {
    let opened = 0;
    const speak = ttsSpeaker({ openTts: async () => { opened++; throw new Error("no"); }, voiceId: "v" }, { ...DEFAULT_CONFIG, silent: true });
    const { floor, line, says, outcomes, bytes } = setup();
    floor.enqueue({ ...line("r1", "result", "T1"), speaker: speak });
    await wait(30);
    expect(opened).toBe(0);
    expect(bytes()).toBe(0);
    expect(says().map((m) => m.state)).toEqual(["start", "end"]);
    expect(outcomes.r1).toBe("spoken");
  });
});
