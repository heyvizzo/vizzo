import { describe, expect, it } from "vitest";
import { isPttKey, isTextInputType } from "./ptt.ts";

describe("push-to-talk key", () => {
  const bare = { ctrlKey: false, altKey: false, metaKey: false };

  it("is a lone Shift", () => {
    expect(isPttKey({ key: "Shift", ...bare })).toBe(true);
    expect(isPttKey({ key: "Shift", ...bare, metaKey: true })).toBe(false);
    expect(isPttKey({ key: "Shift", ...bare, ctrlKey: true })).toBe(false);
    expect(isPttKey({ key: " ", ...bare })).toBe(false);
  });

  it("treats checkboxes, radios and sliders as not typing", () => {
    expect(isTextInputType("checkbox")).toBe(false);
    expect(isTextInputType("radio")).toBe(false);
    expect(isTextInputType("range")).toBe(false);
    expect(isTextInputType("button")).toBe(false);
    expect(isTextInputType("text")).toBe(true);
    expect(isTextInputType("search")).toBe(true);
    expect(isTextInputType("number")).toBe(true);
    expect(isTextInputType("")).toBe(true);
  });
});
