import { describe, expect, it } from "vitest";
import type { CursorSample, Word } from "../../shared/protocol.ts";
import {
  labelsFor, nextSessionId, parseCursorFile, parseLabelsFile, sessionsFromFiles, toCursorFile, toLabelsFile, toRelativeSamples,
  type LabSession,
} from "./session.ts";
import { scoreSessions, targetMatches } from "./scoring.ts";
import { scopeCss } from "./css.ts";
import { buildTimelineModel } from "./timeline.ts";
import { resolvePointing } from "../../shared/pointing.ts";

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
    expect(c.clicks).toBeUndefined(); // older files: no clicks/selection
  });

  it("round-trips clicks and selection (optional fields)", () => {
    const s = session();
    s.clicks = [{ t: 120, x: 5, y: 6, ...card(2), container: "Feature card grid" }];
    s.selection = { t: -40, text: "Charts refresh", ...card(1), container: null };
    const c = parseCursorFile(JSON.stringify(toCursorFile(s)));
    expect(c.clicks).toEqual(s.clicks);
    expect(c.selection).toEqual(s.selection);
    const { sessions } = sessionsFromFiles([{ name: "U04.cursor.json", text: JSON.stringify(toCursorFile(s)) }]);
    expect(sessions[0]!.clicks).toEqual(s.clicks);
    expect(sessions[0]!.selection).toEqual(s.selection);
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

describe("scoring", () => {
  it("targetMatches by data-source, else elementPath", () => {
    expect(targetMatches(smp(0, 50), card(1))).toBe(true);
    expect(targetMatches(smp(0, 150), card(1))).toBe(false);
    expect(targetMatches(smp(0, 50), { ...card(1), dataSource: null })).toBe(true);
    expect(targetMatches(null, card(1))).toBe(false);
    expect(targetMatches(smp(0, 50), null)).toBe(false);
  });

  it("scores each algorithm over labeled words only", () => {
    const a = session();
    a.labels[0]!.target = card(1);
    a.labels[1]!.target = card(3);
    const b = { ...session(), id: "U05", labels: labelsFor(words) }; // unlabeled
    b.labels[0]!.target = card(2); // deliberately wrong label
    const sc = scoreSessions([a, b], { preMs: 300, postMs: 200 });
    expect(sc.overall.dwell).toEqual({ correct: 2, total: 3 });
    expect(sc.perSession.U04!.dwell).toEqual({ correct: 2, total: 2 });
    expect(sc.perSession.U05!.mode).toEqual({ correct: 0, total: 1 });
    expect(sc.details.filter((d) => d.sessionId === "U04")).toHaveLength(2 * sc.algorithms.length);
  });
});

describe("scopeCss", () => {
  it("wraps in @scope and rewrites root selectors", () => {
    const out = scopeCss(`/* c */ :root{--a:1} html body{margin:0} body.dark .card-body{color:red} @media (max-width: 600px){ body{padding:0} .x{y:z} }`, "#demo-root");
    expect(out.startsWith("@scope (#demo-root) {")).toBe(true);
    expect(out).toContain(":scope{--a:1}");
    expect(out).toContain(":scope{margin:0}");
    expect(out).toContain(":scope.dark .card-body{color:red}");
    expect(out).toContain("@media (max-width: 600px){ :scope{padding:0} .x{y:z} }");
    expect(out).not.toContain("/* c */");
  });
});

describe("timeline model", () => {
  it("builds speed in px/s, windows for pointing words, and pick markers", () => {
    const opts = { preMs: 300, postMs: 200 };
    const targets = resolvePointing(words, 0, samples, opts);
    const m = buildTimelineModel(samples, words, targets, opts);
    expect(m.speed.length).toBe(samples.length - 1);
    expect(Math.max(...m.speed.map((p) => p.v))).toBeCloseTo((200 / 300) * 1000, -1);
    expect(m.words.filter((w) => w.win).map((w) => w.win)).toEqual([[-50, 600], [500, 1200]]);
    expect(m.picks).toHaveLength(targets.length);
    expect(m.t0).toBe(-284); // first sample has no speed
    expect(m.t1).toBeGreaterThanOrEqual(1200);
  });
});
