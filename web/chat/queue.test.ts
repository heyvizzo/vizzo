import { describe, expect, it } from "vitest";
import { isQueuedId, queuedAnchor, queuedThreads, recordedMs, recordedPcm, shiftMsg, type Recorded } from "./queue.ts";

describe("shiftMsg", () => {
  it("moves every client time", () => {
    expect(shiftMsg({ type: "turn.release", turnId: "a", tRelease: 100, auto: true }, 50)).toEqual({ type: "turn.release", turnId: "a", tRelease: 150, auto: true });
    expect(shiftMsg({ type: "turn.audioStart", turnId: "a", tAudioStart: 10 }, 5)).toMatchObject({ tAudioStart: 15 });
    const s = shiftMsg({ type: "cursor.samples", turnId: "a", samples: [{ t: 1, x: 0, y: 0, scrollX: 0, scrollY: 0 } as never] }, 9);
    expect(s.type === "cursor.samples" && s.samples[0]!.t).toBe(10);
  });

  it("shifts clicks, the preselection and highlights", () => {
    const msg = {
      type: "turn.context" as const, turnId: "a",
      clicks: [{ t: 1, tEnd: 2, times: [1, 2] }], preselected: { t: 0, text: "x" }, highlights: [{ t: 5, tStart: 3, text: "y" }],
    } as never;
    expect(shiftMsg(msg, 100)).toMatchObject({
      clicks: [{ t: 101, tEnd: 102, times: [101, 102] }], preselected: { t: 100 }, highlights: [{ t: 105, tStart: 103 }],
    });
  });
});

describe("recordedMs", () => {
  it("is press to release", () => {
    const rec: Recorded[] = [
      { msg: { type: "turn.start", turnId: "a", tPress: 1000, config: {} as never } },
      { pcm: new Int16Array(4) },
      { msg: { type: "turn.release", turnId: "a", tRelease: 3500 } },
    ];
    expect(recordedMs(rec)).toBe(2500);
  });
});

describe("recordedPcm", () => {
  it("joins the recorded audio in order", () => {
    const rec: Recorded[] = [{ pcm: new Int16Array([1, 2]) }, { msg: { type: "turn.release", turnId: "a", tRelease: 1 } }, { pcm: new Int16Array([3]) }];
    expect([...recordedPcm(rec)]).toEqual([1, 2, 3]);
  });
});

describe("queuedAnchor", () => {
  const sample = (t: number, path: string | null) => ({ t, x: 10, y: 20, scrollX: 0, scrollY: 100, elementPath: path }) as never;
  const rec = (pageUrl: string | undefined, samples: unknown[]): Recorded[] => [
    { msg: { type: "turn.start", turnId: "a", tPress: 0, config: {} as never, ...(pageUrl ? { pageUrl } : {}) } },
    { msg: { type: "turn.audioStart", turnId: "a", tAudioStart: 0 } },
    { msg: { type: "cursor.samples", turnId: "a", samples: samples as never } },
    { msg: { type: "turn.release", turnId: "a", tRelease: 2000 } },
  ];

  it("is the element the cursor stayed on, on the recorded page", () => {
    const samples = [...Array.from({ length: 15 }, (_, i) => sample(i * 100, "body > button")), sample(1600, "body > p")];
    const a = queuedAnchor(rec("http://x/#top", samples));
    expect(a).toMatchObject({ pageUrl: "http://x/", domPath: "body > button", point: { x: 10, y: 120 } });
  });

  it("is where the user last clicked, not where the cursor rested or ended up", () => {
    const samples = [...Array.from({ length: 15 }, (_, i) => sample(i * 100, "body > button")), sample(1600, "body > p")];
    const click = (t: number, path: string, x: number) => ({ elementPath: path, dataSource: null, label: null, kind: "single", count: 1, t, tEnd: t, times: [t], x, y: 5 });
    const r = rec("http://x/", samples);
    r.splice(3, 0, { msg: { type: "turn.context", turnId: "a", clicks: [click(500, "body > h1", 40), click(300, "body > nav", 1)] as never, preselected: null, highlights: [] } });
    expect(queuedAnchor(r)).toMatchObject({ domPath: "body > h1", point: { x: 40, y: 105 } });
  });

  it("with an on-device transcript, rests count only while the user spoke (like a sent turn)", () => {
    // Talks about the button for 0.9 s, then moves to the header and stays there, silent, until release.
    const samples = [...Array.from({ length: 9 }, (_, i) => sample(i * 100, "body > button")), ...Array.from({ length: 10 }, (_, i) => sample(1000 + i * 100, "body > h1"))];
    const words = [{ text: "Make", start: 0.1, end: 0.3 }, { text: "it", start: 0.3, end: 0.5 }, { text: "bigger", start: 0.5, end: 0.9 }];
    expect(queuedAnchor(rec("http://x/", samples))).toMatchObject({ domPath: "body > h1" }); // whole recording = speech
    expect(queuedAnchor(rec("http://x/", samples), words, ["en"])).toMatchObject({ domPath: "body > button" });
  });

  it("is null without a page or an element", () => {
    expect(queuedAnchor(rec(undefined, [sample(0, "body > button")]))).toBeNull();
    expect(queuedAnchor(rec("http://x/", [sample(0, null)]))).toBeNull();
  });
});

describe("queuedThreads", () => {
  const anchor = { pageUrl: "http://x/", selector: "button", domPath: "body > button", dataSource: null, label: "Buy", text: "Buy", role: null, tag: "button", bounds: { x: 0, y: 0, width: 1, height: 1 } };
  it("is a queued thread with the feedback as its request", () => {
    const [t] = queuedThreads([{ turnId: "a", anchor, text: "make it red", at: 5 }]);
    expect(t).toMatchObject({ threadId: "queued:a", state: "queued", title: "the 'Buy' button", messages: [{ kind: "request", text: "make it red" }] });
    expect(isQueuedId(t!.threadId)).toBe(true);
  });
  it("groups feedback on the same element into one thread, in order", () => {
    const other = { ...anchor, domPath: "body > a", tag: "a" };
    const ts = queuedThreads([
      { turnId: "a", anchor, text: "make it red", at: 5 },
      { turnId: "b", anchor: other, text: "bigger", at: 6 },
      { turnId: "c", anchor: { ...anchor, bounds: { x: 3, y: 3, width: 1, height: 1 } }, text: "and round", at: 7 },
    ]);
    expect(ts.map((t) => t.threadId)).toEqual(["queued:a", "queued:b"]);
    expect(ts[0]).toMatchObject({ createdAt: 5, lastInteractionAt: 7, messages: [{ kind: "request", text: "make it red" }, { kind: "followup", text: "and round", turnId: "c" }] });
  });
});
