import { describe, expect, it } from "vitest";
import { clickCoords, formatCoords } from "./clickCoords.ts";

const page = { width: 2000, height: 4000 };
const box = { left: 100, top: 200, width: 400, height: 100 };

describe("clickCoords", () => {
  it("gives px and % in the pressed element and on the page (scroll included)", () => {
    const c = clickCoords({ x: 220, y: 234 }, { x: 0, y: 500 }, page, box);
    expect(c.container.size).toEqual({ width: 400, height: 100 });
    expect(c.container.at).toEqual({ px: { x: 120, y: 34 }, pct: { x: 30, y: 34 } });
    expect(c.page.size).toEqual(page);
    expect(c.page.at).toEqual({ px: { x: 220, y: 734 }, pct: { x: 11, y: 18.35 } });
  });

  it("is 0% for a zero-sized box or page instead of NaN", () => {
    const c = clickCoords({ x: 5, y: 5 }, { x: 0, y: 0 }, { width: 0, height: 0 }, { left: 0, top: 0, width: 0, height: 0 });
    expect(c.container.at.pct).toEqual({ x: 0, y: 0 });
    expect(c.page.at.pct).toEqual({ x: 0, y: 0 });
  });

  it("copies the sizes, so a later change to them can't alter the record", () => {
    const size = { ...page };
    const c = clickCoords({ x: 0, y: 0 }, { x: 0, y: 0 }, size, box);
    size.width = 1;
    expect(c.page.size.width).toBe(2000);
  });
});

describe("formatCoords", () => {
  it("writes % and px for the element and for the page", () => {
    const c = clickCoords({ x: 220, y: 234 }, { x: 0, y: 500 }, page, box);
    expect(formatCoords(c)).toBe("30%, 34% (120, 34 px) of its 400×100 box, 11%, 18.35% (220, 734 px) of the 2000×4000 page");
  });
});
