import { describe, expect, it } from "vitest";
import { fixturesFromFiles } from "./fixtures.ts";

const cursor = (id: string) => JSON.stringify({
  version: 1, kind: "cursor", id, createdAt: "", transcript: "move this", words: [{ text: "move", start: 0, end: 0.2 }, { text: "this", start: 0.3, end: 0.5 }],
  samples: [{ t: 0, x: 1, y: 2, scrollX: 0, scrollY: 0, elementPath: "div", dataSource: null, label: null }],
});

describe("fixturesFromFiles", () => {
  it("groups wav + cursor + labels, and accepts a cursor-less wav", () => {
    const { fixtures, errors } = fixturesFromFiles([
      { name: "U01.wav", blob: new Blob(["x"]) },
      { name: "U01.cursor.json", text: cursor("U01") },
      { name: "U02.wav", blob: new Blob(["y"]) },
      { name: "notes.txt", text: "" },
    ]);
    expect(fixtures.map((f) => f.id)).toEqual(["U01", "U02"]);
    expect(fixtures[0]).toMatchObject({ transcript: "move this", pointingWords: 1 });
    expect(fixtures[0]!.samples).toHaveLength(1);
    expect(fixtures[1]!.samples).toEqual([]);
    expect(errors).toEqual(["notes.txt: unrecognized file name"]);
  });
  it("reports a cursor file without a wav", () => {
    const { fixtures, errors } = fixturesFromFiles([{ name: "U03.cursor.json", text: cursor("U03") }]);
    expect(fixtures).toHaveLength(1);
    expect(errors).toEqual(["U03: no U03.wav (cannot replay)"]);
  });
});
