import { describe, expect, it } from "vitest";
import type { CursorSample, PageClick, PageSelection, Word } from "./protocol.ts";
import {
  ALGORITHMS, DWELL_TIE_EPS, atStart, dedupeClicks, dwell, dwellMode, formatPageContext, formatPointingContext, isPointingWord,
  mode, normalizeWord, resolvePointing, sampleSpeeds, tagFromPath, truncateText, wordNear, wordWindow,
} from "./pointing.ts";

const T0 = 10_000; // tAudioStart

/** Element at a pixel: three 100px-wide columns. */
function elAt(x: number): { elementPath: string; dataSource: string; label: string } {
  const i = Math.max(0, Math.min(2, Math.floor(x / 100)));
  return {
    elementPath: `#demo-root > main > article:nth-of-type(${i + 1})`,
    dataSource: `web/cursor/demo/demo.html:${10 + i}`,
    label: `Card ${i + 1}`,
  };
}

function s(t: number, x: number, y = 50): CursorSample {
  return { t, x, y, scrollX: 0, scrollY: 0, ...elAt(x) };
}

/** Piecewise-linear trail sampled every `dt` ms. keys: [t, x] in absolute time. */
function trail(keys: [number, number][], dt = 16): CursorSample[] {
  const out: CursorSample[] = [];
  const end = keys[keys.length - 1]![0];
  for (let t = keys[0]![0]; t <= end; t += dt) {
    let x = keys[keys.length - 1]![1];
    for (let k = 1; k < keys.length; k++) {
      const [ta, xa] = keys[k - 1]!;
      const [tb, xb] = keys[k]!;
      if (t <= tb) {
        x = tb === ta ? xb : xa + ((xb - xa) * (t - ta)) / (tb - ta);
        break;
      }
    }
    out.push(s(t, x));
  }
  return out;
}

const w = (text: string, start: number, end: number): Word => ({ text, start, end });

describe("words", () => {
  it("normalizes punctuation and case", () => {
    expect(normalizeWord("This,")).toBe("this");
    expect(normalizeWord("“there?”")).toBe("there");
    expect(isPointingWord("THOSE.")).toBe(true);
    expect(isPointingWord("these!")).toBe(true);
    expect(isPointingWord("thistle")).toBe(false);
    expect(isPointingWord("the")).toBe(false);
  });

  it("computes the window in absolute time", () => {
    expect(wordWindow(w("this", 0.5, 0.7), T0, { preMs: 300, postMs: 200 })).toEqual({
      tStart: 10_500, tEnd: 10_700, from: 10_200, to: 10_900,
    });
  });
});

describe("sampleSpeeds", () => {
  it("is distance / dt relative to the previous sample, NaN for the first and dt ≤ 0", () => {
    const sp = sampleSpeeds([s(0, 0, 0), { ...s(10, 30, 40) }, s(10, 30, 40), s(20, 30, 40)]);
    expect(sp[0]).toBeNaN();
    expect(sp[1]).toBe(5); // 50px / 10ms
    expect(sp[2]).toBeNaN();
    expect(sp[3]).toBe(0);
  });
});

describe("resolvers", () => {
  // Cursor sweeps across card 1 → rests on card 2 (x=150) from 10_400 to 10_700 → moves on to card 3.
  // Word "this" spoken at 0.55–0.75 s (abs 10_550–10_750); window [10_250, 10_950].
  const samples = trail([[10_000, 20], [10_400, 150], [10_700, 150], [11_000, 280], [11_500, 280]]);
  const word = w("this", 0.55, 0.75);

  it("atStart picks the sample closest to the word start", () => {
    const r = atStart(word, T0, samples)!;
    expect(Math.abs(r.t - 10_550)).toBeLessThanOrEqual(8);
  });

  it("dwell picks the pause on card 2", () => {
    expect(dwell(word, T0, samples)!.label).toBe("Card 2");
  });

  it("dwell breaks exact ties toward the word start", () => {
    const r = dwell(word, T0, samples)!;
    // stationary 10_400..10_700: the zero-speed sample closest to 10_550
    expect(Math.abs(r.t - 10_550)).toBeLessThanOrEqual(8);
  });

  it("mode picks the element with most samples in the window", () => {
    expect(mode(word, T0, samples)!.label).toBe("Card 2");
  });

  it("atStart differs from dwell when the word comes late (user already moving away)", () => {
    // word starts at 10_900 when the cursor is crossing into card 3, but the pause was on card 2.
    const late = w("this", 0.9, 1.0);
    expect(atStart(late, T0, samples)!.label).toBe("Card 3");
    expect(dwell(late, T0, samples, { preMs: 600, postMs: 0 })!.label).toBe("Card 2");
  });

  it("window opts change the outcome", () => {
    const late = w("this", 0.9, 1.0);
    // With a tiny pre window the pause on card 2 is out of range.
    expect(dwell(late, T0, samples, { preMs: 0, postMs: 0 })!.label).not.toBe("Card 2");
  });

  it("returns null with no samples (atStart) or none in the window (others)", () => {
    expect(atStart(word, T0, [])).toBeNull();
    const far = [s(0, 10), s(16, 10)];
    expect(dwell(word, T0, far)).toBeNull();
    expect(mode(word, T0, far)).toBeNull();
    expect(dwellMode(word, T0, far)).toBeNull();
    expect(atStart(word, T0, far)!.t).toBe(16);
  });

  it("mode ignores null elementPaths", () => {
    const nulls = trail([[10_200, 150], [10_900, 150]]).map((x, i) => (i % 3 ? { ...x, elementPath: null } : x));
    expect(mode(word, T0, nulls)!.elementPath).toContain("article:nth-of-type(2)");
    const allNull = nulls.map((x) => ({ ...x, elementPath: null }));
    expect(mode(word, T0, allNull)).toBeNull();
  });

  it("handles unsorted input", () => {
    const shuffled = [...samples].reverse();
    expect(dwell(word, T0, shuffled)!.label).toBe("Card 2");
    expect(atStart(word, T0, shuffled)!.t).toBe(atStart(word, T0, samples)!.t);
  });

  it("dwell with a single in-window sample (no previous) still returns it", () => {
    const one = [s(10_550, 150)];
    expect(dwell(word, T0, one)!.t).toBe(10_550);
    expect(dwellMode(word, T0, one)!.t).toBe(10_550);
  });
});

describe("dwellMode", () => {
  const word = w("that", 0.5, 0.6); // window [10_200, 10_800]

  it("breaks near-ties toward the mode element", () => {
    // Card 1: a short exact stop (2 samples speed 0) right at word start.
    // Card 2: a long slow drift (speed ~0.01 px/ms, within EPS) — the mode element.
    const smp: CursorSample[] = [];
    let t = 10_200;
    let x = 140;
    for (; t < 10_480; t += 16) smp.push(s(t, (x += 0.16))); // 0.01 px/ms drift on card 2
    smp.push(s(t, 50)); // jump to card 1
    t += 16; smp.push(s(t, 50)); // speed 0
    t += 16; smp.push(s(t, 50)); // speed 0
    t += 16; x = 160;
    smp.push(s(t, x)); // jump back
    for (t += 16; t <= 10_800; t += 16) smp.push(s(t, (x += 0.16)));

    expect(0.01).toBeLessThan(DWELL_TIE_EPS);
    expect(dwell(word, T0, smp)!.label).toBe("Card 1");
    expect(mode(word, T0, smp)!.label).toBe("Card 2");
    expect(dwellMode(word, T0, smp)!.label).toBe("Card 2");
  });

  it("keeps the dwell pick when the mode element is clearly faster", () => {
    // Card 2 has most samples but moves fast (2 px/ms); card 1 is a real stop.
    const smp: CursorSample[] = [];
    let t = 10_200;
    let x = 100;
    for (; t < 10_600; t += 16) smp.push(s(t, (x = x >= 196 ? 100 : x + 32))); // zig on card 2
    for (; t <= 10_800; t += 16) smp.push(s(t, 50));
    expect(dwellMode(word, T0, smp)!.label).toBe("Card 1");
  });
});

describe("resolvePointing", () => {
  const samples = trail([[10_000, 50], [10_300, 50], [10_600, 250], [11_200, 250]]);
  const words = [w("Move", 0.0, 0.2), w("this", 0.2, 0.35), w("over", 0.5, 0.65), w("there.", 0.8, 1.0)];

  it("runs every resolver on every pointing word, in order", () => {
    const r = resolvePointing(words, T0, samples);
    expect(r).toHaveLength(2 * ALGORITHMS.length);
    expect(r.map((x) => x.algorithm).slice(0, 4)).toEqual(["atStart", "dwell", "mode", "dwellMode"]);
    expect(r.slice(0, 4).every((x) => x.word === "this" && x.wordStart === 0.2)).toBe(true);
    expect(r.slice(4).every((x) => x.word === "there")).toBe(true);
  });

  it("two pointing words resolve to two different cards (U4)", () => {
    const r = resolvePointing(words, T0, samples);
    const dw = r.filter((x) => x.algorithm === "dwell");
    expect(dw[0]!.sample!.label).toBe("Card 1");
    expect(dw[1]!.sample!.label).toBe("Card 3");
  });

  it("returns [] without pointing words", () => {
    expect(resolvePointing([w("hello", 0, 0.3)], T0, samples)).toEqual([]);
  });
});

describe("formatPointingContext", () => {
  it("formats one line per word for the chosen algorithm", () => {
    const sample: CursorSample = {
      t: 0, x: 0, y: 0, scrollX: 0, scrollY: 0,
      elementPath: "#demo-root > section.hero:nth-of-type(1) > button#cta.primary",
      dataSource: "web/cursor/demo/demo.html:42", label: "Get started",
    };
    const targets = [
      { word: "this", wordStart: 0.2, algorithm: "dwell", sample },
      { word: "this", wordStart: 0.2, algorithm: "dwellMode", sample },
      { word: "there", wordStart: 0.8, algorithm: "dwellMode", sample: null },
    ];
    expect(formatPointingContext(targets)).toBe(
      `Pointing: "this" → <button> "Get started" [data-source=web/cursor/demo/demo.html:42]\nPointing: "there" → (nothing)`,
    );
    expect(formatPointingContext(targets, "dwell").split("\n")).toHaveLength(1);
    expect(formatPointingContext([])).toBe("");
  });

  it("omits missing parts", () => {
    const sample: CursorSample = { t: 0, x: 0, y: 0, scrollX: 0, scrollY: 0, elementPath: "div > p", dataSource: null, label: null };
    expect(formatPointingContext([{ word: "here", wordStart: 0, algorithm: "mode", sample }], "mode")).toBe(`Pointing: "here" → <p>`);
  });

  it("names the container when it differs from the label", () => {
    const base = { t: 0, x: 0, y: 0, scrollX: 0, scrollY: 0, elementPath: "main > article:nth-of-type(1) > h3", dataSource: "web/cursor/demo/demo.html:36", label: "Live queries" };
    const line = (container: string | null) =>
      formatPointingContext([{ word: "this", wordStart: 0, algorithm: "dwellMode", sample: { ...base, container } }]);
    expect(line("Card: Live queries")).toBe(`Pointing: "this" → <h3> "Live queries" in "Card: Live queries" [data-source=web/cursor/demo/demo.html:36]`);
    expect(line(null)).toBe(`Pointing: "this" → <h3> "Live queries" [data-source=web/cursor/demo/demo.html:36]`);
    expect(line("Live queries")).toBe(`Pointing: "this" → <h3> "Live queries" [data-source=web/cursor/demo/demo.html:36]`);
  });

  it("tagFromPath", () => {
    expect(tagFromPath("main > td:nth-of-type(2)")).toBe("td");
    expect(tagFromPath("#demo-root")).toBeNull();
    expect(tagFromPath(null)).toBeNull();
  });
});

describe("formatPageContext", () => {
  const DS = "web/cursor/demo/demo.html";
  const th = { elementPath: "table > thead > tr > th:nth-of-type(4)", dataSource: `${DS}:67`, label: "Price / month", container: "Pricing table" };
  const cta = { elementPath: "section > button", dataSource: `${DS}:27`, label: "Get started", container: "Hero section" };
  const click = (t: number, el: typeof th): PageClick => ({ t, x: 1, y: 2, ...el });
  // "how much is this one" — "this" spans 10_600..10_900
  const words: Word[] = [w("how", 0.0, 0.2), w("much", 0.2, 0.4), w("is", 0.4, 0.6), w("this", 0.6, 0.9), w("one", 0.9, 1.1)];

  it("one Clicked line per click, naming the word being said", () => {
    expect(formatPageContext([click(T0 + 700, th)], null, words, T0)).toBe(
      `Clicked: <th> "Price / month" in "Pricing table" [data-source=${DS}:67] (while saying "this")`,
    );
  });

  it("omits the word without words / tAudioStart, or when no word is near", () => {
    expect(formatPageContext([click(T0 + 700, th)], null, [], T0)).not.toContain("while saying");
    expect(formatPageContext([click(T0 + 700, th)], null, words, undefined)).not.toContain("while saying");
    expect(formatPageContext([click(T0 + 5000, th)], null, words, T0)).not.toContain("while saying");
  });

  it("dedupes consecutive clicks on the same element and keeps the latest 5", () => {
    const lines = formatPageContext([click(T0 + 900, cta), click(T0 + 100, th), click(T0 + 200, th)], null, words, T0).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`"Price / month"`);
    expect(lines[0]).toContain(`(while saying "how")`);
    expect(lines[1]).toContain(`"Get started" in "Hero section"`);
    const many = Array.from({ length: 8 }, (_, i) => click(i * 10, i % 2 ? th : cta));
    expect(dedupeClicks(many)).toHaveLength(5);
    expect(dedupeClicks(many)[4]!.t).toBe(70);
    expect(dedupeClicks([{ t: 0, x: 0, y: 0, elementPath: null, dataSource: null, label: null }])).toEqual([]);
  });

  it("adds the selected text with its element, dropping a label that only repeats the text", () => {
    const p = { elementPath: "article > p", dataSource: `${DS}:37`, label: "Charts refresh as rows land. Postgres, MySQL and BigQuery…", container: "Card: Live queries" };
    const sel: PageSelection = { t: T0, text: "  Charts refresh\n as rows land. ", ...p };
    expect(formatPageContext([], sel, words, T0)).toBe(`Selected text: "Charts refresh as rows land." in <p> in "Card: Live queries" [data-source=${DS}:37]`);
    const other: PageSelection = { ...sel, text: "Pricing", label: "Plan", elementPath: "th", container: null };
    expect(formatPageContext([click(T0 + 700, th)], other, words, T0).split("\n")[1]).toBe(`Selected text: "Pricing" in <th> "Plan" [data-source=${DS}:37]`);
    expect(formatPageContext([], { ...sel, text: "   " }, words, T0)).toBe("");
    expect(formatPageContext([], null, words, T0)).toBe("");
  });

  it("truncates long selections to ~200 chars", () => {
    expect(truncateText("x".repeat(500))).toHaveLength(200);
    expect(truncateText("x".repeat(500)).endsWith("…")).toBe(true);
  });

  it("wordNear picks the nearest span (inside = 0)", () => {
    expect(wordNear(T0 + 650, words, T0)!.text).toBe("this");
    expect(wordNear(T0 - 300, words, T0)!.text).toBe("how");
    expect(wordNear(T0 + 3000, words, T0)).toBeNull();
  });
});
