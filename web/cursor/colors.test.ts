import { describe, expect, it } from "vitest";
import { stateColorVars, toneOfCss, STATE_COLORS_ON_LIGHT } from "./colors.ts";

describe("toneOfCss", () => {
  it("tells light backgrounds from dark ones", () => {
    expect(toneOfCss("rgb(255, 255, 255)")).toBe("light");
    expect(toneOfCss("rgb(245, 239, 230)")).toBe("light");
    expect(toneOfCss("rgb(17, 24, 39)")).toBe("dark");
    expect(toneOfCss("rgb(55, 65, 81)")).toBe("dark");
  });
  it("skips transparent and unparsed colours", () => {
    expect(toneOfCss("rgba(0, 0, 0, 0)")).toBeNull();
    expect(toneOfCss("rgba(255, 255, 255, 0.2)")).toBeNull();
    expect(toneOfCss("transparent")).toBeNull();
  });
  it("reads the space-separated form", () => {
    expect(toneOfCss("rgb(250 250 250 / 0.9)")).toBe("light");
  });
});

describe("stateColorVars", () => {
  it("uses the deeper set for light pages", () => {
    expect(stateColorVars("light")["--st-working"]).toBe(STATE_COLORS_ON_LIGHT.working.from);
    expect(stateColorVars("dark")["--st-working"]).not.toBe(STATE_COLORS_ON_LIGHT.working.from);
  });
});
