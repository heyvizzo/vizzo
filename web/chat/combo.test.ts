import { describe, expect, it } from "vitest";
import { comboMatches } from "./combo.ts";

const OPTS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];

describe("comboMatches", () => {
  it("lists everything when nothing is typed or the value is an option", () => {
    expect(comboMatches(OPTS, "")).toEqual(OPTS);
    expect(comboMatches(OPTS, "claude-opus-5-5")).toEqual(OPTS);
  });
  it("filters by substring, ignoring case", () => {
    expect(comboMatches(OPTS, "SON")).toEqual(["claude-sonnet-5-5"]);
    expect(comboMatches(OPTS, "gpt")).toEqual([]);
  });
});
