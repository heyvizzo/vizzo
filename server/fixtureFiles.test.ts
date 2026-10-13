import { describe, expect, it } from "vitest";
import { readFixtureFile } from "./fixtureFiles.ts";

describe("readFixtureFile", () => {
  it("rejects anything but plain fixture names", async () => {
    for (const n of ["../package.json", "../../.env", "a/b.wav", "U01.txt", ".wav", "U01.wav/..", "..%2F.env"])
      expect(await readFixtureFile(n)).toBeNull();
  });
  it("returns null for a missing file", async () => {
    expect(await readFixtureFile("ZZ_missing.wav")).toBeNull();
  });
});
