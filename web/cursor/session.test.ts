import { describe, expect, it } from "vitest";
import type { CursorSample, Word } from "../../shared/protocol.ts";
import {
  labelsFor, nextSessionId, parseCursorFile, parseLabelsFile, sessionEvents, sessionsFromFiles, shiftEvents, toCursorFile, toLabelsFile,
  toRelativeSamples,
  type LabSession,
} from "./session.ts";
const card = (i: number) => ({ elementPath: `#demo-root > article:nth-of-type(${i})`, dataSource: `demo.html:${i}`, label: `Card ${i}` });
const smp = (t: number, x: number): CursorSample => ({ t, x, y: 10, scrollX: 0, scrollY: 0, ...card(x < 100 ? 1 : x < 200 ? 2 : 3) });

const words: Word[] = [
  { text: "Move", start: 0, end: 0.2 }, { text: "this", start: 0.25, end: 0.4 },
  { text: "over", start: 0.5, end: 0.6 }, { text: "there.", start: 0.8, end: 1.0 },
];
// Rest on card 1 until 400 ms, travel, rest on card 3 from 700 ms.
const samples: CursorSample[] = [];
for (let t = -300; t <= 1300; t += 16) samples.push(smp(t, t < 400 ? 50 : t < 700 ? 50 + ((t - 400) / 300) * 200 : 250));

function session(): LabSession {
  return { id: "U04", createdAt: "2026-10-13T00:00:00Z", transcript: "Move this over there.", words, samples, labels: labelsFor(words) };
}

describe("session files", () => {
  it("toRelativeSamples shifts and clips", () => {
    const abs = [smp(900, 1), smp(1000, 1), smp(1500, 1)];
    expect(toRelativeSamples(abs, 1000, 950, 1600).map((s) => s.t)).toEqual([0, 500]);
  });

  it("labelsFor creates one entry per pointing word and keeps matching labels", () => {
    const l = labelsFor(words);
    expect(l.map((x) => [x.wordIndex, x.word, x.target])).toEqual([[1, "this", null], [3, "there", null]]);
    l[0]!.target = card(1);
    const again = labelsFor(words, l);
    expect(again[0]!.target).toEqual(card(1));
    // A different transcript with "this" at another index drops the label.
    expect(labelsFor([{ text: "this", start: 0, end: 0.1 }], l)[0]!.target).toBeNull();
  });

  it("round-trips through JSON", () => {
    const s = session();
    s.labels[0]!.target = card(1);
    const c = parseCursorFile(JSON.stringify(toCursorFile(s)));
    const l = parseLabelsFile(JSON.stringify(toLabelsFile(s)));
    expect(c.words).toEqual(words);
    expect(c.samples).toEqual(samples);
    expect(l.labels).toEqual(s.labels);
    expect(c.clicks).toBeUndefined(); // no page events: the fields are left out
    expect(c.highlights).toBeUndefined();
  });

  it("round-trips click events, the pre-existing highlight and highlights (optional fields)", () => {
    const s = session();
    s.clicks = [
      { ...card(2), container: "Feature card grid", kind: "double", count: 2, t: 120, tEnd: 330, times: [120, 260], x: 5, y: 6 },
      { ...card(3), container: null, kind: "multi", count: 5, t: 900, tEnd: 1550, times: [900, 1050, 1200, 1350, 1480], x: 9, y: 9 },
    ];
    s.preselected = { t: -40, text: "Charts refresh", ...card(1), container: null };
    s.highlights = [
      { text: "Hobby 3 5 $0\nTeam Unlimited 50 $49", tStart: 300, t: 650, ...card(2), container: "Pricing table", via: "drag" },
      { text: "Drop any chart", tStart: 1000, t: 1350, ...card(3), container: null },
    ];
    const file = toCursorFile(s);
    expect(file).not.toHaveProperty("selection");
    const c = parseCursorFile(JSON.stringify(file));
    expect(c.clicks).toEqual(s.clicks);
    expect(c.preselected).toEqual(s.preselected);
    expect(c.highlights).toEqual(s.highlights);
    const { sessions } = sessionsFromFiles([{ name: "U04.cursor.json", text: JSON.stringify(file) }]);
    expect(sessionEvents(sessions[0]!)).toEqual({ clicks: s.clicks, preselected: s.preselected, highlights: s.highlights });
  });

  it("loads old files: kind-less clicks become single clicks, `selection` becomes a highlight", () => {
    const old = {
      ...toCursorFile(session()),
      clicks: [{ t: 120, x: 5, y: 6, ...card(2), container: "Feature card grid" }, { t: 400, x: 1, y: 1, ...card(1) }],
      selection: { t: -40, text: "Charts refresh", ...card(1), container: null },
    };
    const c = parseCursorFile(JSON.stringify(old));
    expect(c.clicks).toEqual([
      { ...card(2), container: "Feature card grid", kind: "single", count: 1, t: 120, tEnd: 120, times: [120], x: 5, y: 6 },
      { ...card(1), kind: "single", count: 1, t: 400, tEnd: 400, times: [400], x: 1, y: 1 },
    ]);
    expect(c.highlights).toEqual([{ ...card(1), container: null, text: "Charts refresh", tStart: -40, t: -40 }]);
    expect(c.preselected).toBeUndefined();
    expect(c.highlights![0]).not.toHaveProperty("via");
    // Re-saving writes the new shape.
    const again = toCursorFile(sessionsFromFiles([{ name: "U04.cursor.json", text: JSON.stringify(old) }]).sessions[0]!);
    expect(again).not.toHaveProperty("selection");
    expect(again.highlights).toHaveLength(1);
    // A malformed click list is dropped rather than failing the load.
    expect(parseCursorFile(JSON.stringify({ ...old, clicks: [{ t: "x" }] })).clicks).toBeUndefined();
  });

  it("shiftEvents moves every time (absolute <-> relative)", () => {
    const ev = shiftEvents({
      clicks: [{ ...card(1), kind: "double", count: 2, t: 1000, tEnd: 1250, times: [1000, 1180], x: 0, y: 0 }],
      preselected: { ...card(1), t: 900, text: "a" },
      highlights: [{ ...card(2), text: "b", tStart: 1100, t: 1400 }],
    }, -1000);
    expect([ev.clicks[0]!.t, ev.clicks[0]!.tEnd, ev.clicks[0]!.times]).toEqual([0, 250, [0, 180]]);
    expect(ev.preselected!.t).toBe(-100);
    expect([ev.highlights[0]!.tStart, ev.highlights[0]!.t]).toEqual([100, 400]);
  });

  it("rejects malformed files", () => {
    expect(() => parseCursorFile(JSON.stringify({ kind: "labels", version: 1 }))).toThrow(/cursor/);
    expect(() => parseCursorFile(JSON.stringify({ kind: "cursor", version: 1, id: "U1", words: [], samples: [{ t: 0 }] }))).toThrow(/samples/);
    expect(() => parseLabelsFile(JSON.stringify({ kind: "labels", version: 1, id: "U1", labels: [{ wordIndex: "x" }] }))).toThrow(/label #0/);
  });

  it("groups loaded files by id", () => {
    const s = session();
    s.labels[1]!.target = card(3);
    const wav = new Blob([new Uint8Array(4)]);
    const { sessions, errors } = sessionsFromFiles([
      { name: "U04.cursor.json", text: JSON.stringify(toCursorFile(s)) },
      { name: "U04.labels.json", text: JSON.stringify(toLabelsFile(s)) },
      { name: "U04.wav", blob: wav },
      { name: "U05.labels.json", text: "{}" },
      { name: "notes.txt", text: "" },
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.labels[1]!.target).toEqual(card(3));
    expect(sessions[0]!.wav).toBe(wav);
    expect(errors).toEqual(["notes.txt: unrecognized file name", "U05: no U05.cursor.json"]);
  });

  it("nextSessionId", () => {
    expect(nextSessionId([])).toBe("U01");
    expect(nextSessionId(["U01", "U09", "U04r", "x"])).toBe("U10");
  });
});

describe("languages and cursor rests", () => {
  const ro: Word[] = [
    { text: "Mută", start: 0, end: 0.2 }, { text: "ăsta", start: 0.25, end: 0.4 }, { text: "acolo.", start: 0.8, end: 1.0 },
  ];

  it("labelsFor finds Romanian pointing words by default and can be limited to one language", () => {
    expect(labelsFor(ro).map((l) => [l.wordIndex, l.word])).toEqual([[1, "ăsta"], [2, "acolo"]]);
    expect(labelsFor(ro, [], ["en"])).toEqual([]);
    expect(labelsFor(words, [], ["ro"])).toEqual([]);
  });

  it("keeps a detected language through the cursor file (and leaves it out when unknown)", () => {
    const s = { ...session(), language: "ro" };
    expect(parseCursorFile(JSON.stringify(toCursorFile(s))).language).toBe("ro");
    expect("language" in toCursorFile(session())).toBe(false);
    const { sessions } = sessionsFromFiles([{ name: "U04.cursor.json", text: JSON.stringify(toCursorFile(s)) }]);
    expect(sessions[0]!.language).toBe("ro");
  });
});
