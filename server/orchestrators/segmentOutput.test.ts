// SegmentOutput.cut: a progress line broken off when the answer is ready, and when it isn't one to break off.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerMsg } from "../../shared/protocol.ts";
import { CUT_TAIL_MS, SegmentOutput } from "./turnBase.ts";

/** 1 s of PCM16 24 kHz. */
const SECOND = Buffer.alloc(48_000);

function setup() {
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const events: ServerMsg[] = [];
  let bytes = 0;
  const out = new SegmentOutput({ turnId: "t1", send: (m) => events.push(m), sendAudio: (b) => { bytes += b.length; } });
  return { out, events, bytes: () => bytes, advance: (ms: number) => { now += ms; } };
}
const cuts = (events: ServerMsg[]) => events.filter((e) => e.type === "audio.cut");

afterEach(() => vi.restoreAllMocks());

describe("SegmentOutput.cut", () => {
  it("a line still coming in is cut off: the client is told, the rest dropped, the next segment goes on", () => {
    const s = setup();
    const filler = s.out.segment("filler");
    const answer = s.out.segment("answer");
    filler.push(SECOND);
    answer.push(SECOND); // waits for the filler
    expect(s.out.cut(filler)).toBe(true);
    expect(cuts(s.events)).toEqual([{ type: "audio.cut", turnId: "t1", segment: "filler" }]);
    filler.push(SECOND); // late audio from the closed socket: dropped
    expect(s.bytes()).toBe(SECOND.length * 2); // the filler's first second, then the answer
    expect(s.events.filter((e) => e.type === "audio.segment").map((e) => (e as { segment: string; state: string }).segment + ":" + (e as { state: string }).state))
      .toEqual(["filler:start", "filler:end", "answer:start"]);
    // The client went quiet at the cut: the answer's second plays from now.
    expect(s.out.playEnd).toBe(1000 + 1000);
  });

  it("a line all sent but still playing is cut off", () => {
    const s = setup();
    const filler = s.out.segment("filler");
    filler.push(SECOND);
    filler.end();
    s.advance(400); // 600 ms of it left to play
    expect(s.out.cut(filler)).toBe(true);
    expect(cuts(s.events)).toHaveLength(1);
  });

  it("a line about to end is left to end: no cut", () => {
    const s = setup();
    const filler = s.out.segment("filler");
    filler.push(SECOND);
    filler.end();
    s.advance(1000 - CUT_TAIL_MS + 50);
    expect(s.out.cut(filler)).toBe(false);
    expect(cuts(s.events)).toHaveLength(0);
  });

  it("a line nobody heard yet (no audio) is dropped silently", () => {
    const s = setup();
    const filler = s.out.segment("filler");
    const answer = s.out.segment("answer");
    expect(s.out.cut(filler)).toBe(false);
    expect(cuts(s.events)).toHaveLength(0);
    answer.push(SECOND);
    expect(s.events.filter((e) => e.type === "audio.segment").map((e) => (e as { segment: string }).segment)).toEqual(["answer"]);
  });
});
