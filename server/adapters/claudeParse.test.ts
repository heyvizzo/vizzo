import { describe, expect, it } from "vitest";
import { JsonStringFieldExtractor, SpokenLineParser } from "./claudeParse.ts";

function feedAll(chunks: string[], field = "ack"): { out: string[]; ex: JsonStringFieldExtractor } {
  const ex = new JsonStringFieldExtractor(field);
  return { out: chunks.map((c) => ex.feed(c)), ex };
}
const chars = (s: string): string[] => [...s];
const decodeAck = (json: string): string => (JSON.parse(json) as { ack: string }).ack;

describe("JsonStringFieldExtractor", () => {
  const cases: Record<string, string> = {
    simple: `{"ack":"Sure, let me check that grid.","question":"Why grid?"}`,
    whitespace: `{ "ack" : "Looking now." , "question" : "q" }`,
    ackAfterQuestion: `{"question":"Why is \\"this\\" a grid?","ack":"One sec."}`,
    escapes: `{"ack":"Say \\"hi\\" \\\\ back\\/slash\\nnew\\tline","question":"q"}`,
    unicode: `{"ack":"Caf\\u00e9 \\u2014 ok","question":"q"}`,
    surrogatePair: `{"ack":"Rocket \\ud83d\\ude80 go","question":"q"}`,
    rawUnicode: `{"ack":"Café — ok 🚀","question":"q"}`,
    nestedDecoy: `{"meta":{"ack":"nope"},"list":["ack","x"],"ack":"yes","question":"q"}`,
    escapedKey: `{"a\\u0063k":"escaped key","question":"q"}`,
    emptyAck: `{"ack":"","question":"q"}`,
  };

  for (const [name, json] of Object.entries(cases)) {
    it(`${name}: one chunk`, () => {
      const { out, ex } = feedAll([json]);
      expect(out.join("")).toBe(decodeAck(json));
      expect(ex.done).toBe(true);
      expect(ex.value).toBe(decodeAck(json));
    });
    it(`${name}: char by char`, () => {
      const { out } = feedAll(chars(json));
      expect(out.join("")).toBe(decodeAck(json));
    });
    it(`${name}: random fragments`, () => {
      let seed = json.length * 7919;
      const rand = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      for (let trial = 0; trial < 20; trial++) {
        const chunks: string[] = [];
        for (let i = 0; i < json.length; ) {
          const n = 1 + Math.floor(rand() * 6);
          chunks.push(json.slice(i, i + n));
          i += n;
        }
        expect(feedAll(chunks).out.join("")).toBe(decodeAck(json));
      }
    });
  }

  it("streams characters before the object is complete", () => {
    const ex = new JsonStringFieldExtractor();
    expect(ex.feed(`{"ack":"Good ques`)).toBe("Good ques");
    expect(ex.done).toBe(false);
    expect(ex.feed(`tion.`)).toBe("tion.");
    expect(ex.feed(`","question":"Why`)).toBe("");
    expect(ex.done).toBe(true);
  });

  it("holds an escape split across fragments", () => {
    const ex = new JsonStringFieldExtractor();
    expect(ex.feed(`{"ack":"a\\`)).toBe("a");
    expect(ex.feed(`"b\\u00`)).toBe(`"b`);
    expect(ex.feed(`e9c"`)).toBe("éc");
  });

  it("does not emit a lone high surrogate until its low half arrives", () => {
    const ex = new JsonStringFieldExtractor();
    expect(ex.feed(`{"ack":"x\\ud83d`)).toBe("x");
    expect(ex.feed(`\\ude80"`)).toBe("🚀");
  });

  it("emits nothing when the field is missing", () => {
    expect(feedAll([`{"question":"ack? no","other":"ack"}`]).out.join("")).toBe("");
  });

  it("supports another field name", () => {
    expect(feedAll([`{"ack":"a","question":"the q"}`], "question").out.join("")).toBe("the q");
  });
});

describe("SpokenLineParser", () => {
  function run(deltas: string[]): { lines: string[]; via: boolean[]; parser: SpokenLineParser } {
    const lines: string[] = [];
    const via: boolean[] = [];
    const parser = new SpokenLineParser((l, v) => { lines.push(l); via.push(v); });
    for (const d of deltas) parser.feed(d);
    return { lines, via, parser };
  }

  const full = "SPOKEN: The cards use grid so rows and columns line up. Flexbox stretched the last row.\n\n## Details\nThe `.card-grid` rule...";

  it("emits the SPOKEN line once the newline arrives (char by char)", () => {
    const lines: string[] = [];
    const p = new SpokenLineParser((l) => lines.push(l));
    const at = full.indexOf("\n");
    for (let i = 0; i < full.length; i++) {
      p.feed(full[i]!);
      expect(lines.length).toBe(i >= at ? 1 : 0);
    }
    expect(lines).toEqual(["The cards use grid so rows and columns line up. Flexbox stretched the last row."]);
    expect(p.end()).toBe(lines[0]);
  });

  it("handles a prefix split across deltas and leading whitespace", () => {
    const { lines, via } = run(["\n ", "SPO", "KEN", ":", " Because it", " sticks.\n", "\nMore"]);
    expect(lines).toEqual(["Because it sticks."]);
    expect(via).toEqual([true]);
  });

  it("accepts markdown-bold and lowercase prefixes", () => {
    expect(run(["**SPOKEN:** It is orange for contrast.\n\nx"]).lines).toEqual(["It is orange for contrast."]);
    expect(run(["spoken: lower case works.\n"]).lines).toEqual(["lower case works."]);
  });

  it("waits for the newline, then end() flushes a line with no newline", () => {
    const { lines, parser } = run(["SPOKEN: no newline yet"]);
    expect(lines).toEqual([]);
    expect(parser.end()).toBe("no newline yet");
    expect(lines).toEqual(["no newline yet"]);
  });

  it("takes the next line when SPOKEN: is alone on its line", () => {
    expect(run(["SPOKEN:\nGrid keeps the columns aligned. More text here.\n"]).lines).toEqual(["Grid keeps the columns aligned."]);
  });

  it("falls back to the first sentence when the prefix is missing", () => {
    const { lines, via } = run(chars("The grid keeps every row on the same columns. Flexbox sizes each row alone.\n\nDetails..."));
    expect(lines).toEqual(["The grid keeps every row on the same columns."]);
    expect(via).toEqual([false]);
  });

  it("fallback: a very short first sentence pulls in the second", () => {
    expect(run(chars("Good question. The header is sticky so the nav stays reachable. Details follow.")).lines)
      .toEqual(["Good question. The header is sticky so the nav stays reachable."]);
  });

  it("fallback: stops at the first newline", () => {
    expect(run(["Short answer\n\nlong details"]).lines).toEqual(["Short answer"]);
  });

  it("fallback: strips a markdown heading and emits on end() with no terminator", () => {
    const { lines, parser } = run(["## Because grid aligns both axes"]);
    expect(lines).toEqual([]);
    parser.end();
    expect(lines).toEqual(["Because grid aligns both axes"]);
  });

  it("does not decide on a partial 'S' that could still be the prefix", () => {
    const { lines, parser } = run(["S"]);
    expect(lines).toEqual([]);
    parser.feed("ure thing. It is sticky because users kept scrolling up. ");
    expect(lines).toEqual(["Sure thing. It is sticky because users kept scrolling up."]);
  });

  it("fires only once", () => {
    const { lines, parser } = run([full, "\nSPOKEN: again\n"]);
    parser.end();
    expect(lines.length).toBe(1);
  });
});
