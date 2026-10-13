import { describe, expect, it } from "vitest";
import type { PageClick } from "../../shared/protocol.ts";
import { cleanSelection, elementOf, isDrag, pushClick } from "./pageContext.ts";

const click = (t: number, elementPath: string | null): PageClick => ({ t, x: 0, y: 0, elementPath, dataSource: null, label: null });

describe("pageContext helpers", () => {
  it("isDrag: movement beyond a few px between down and up", () => {
    expect(isDrag({ x: 10, y: 10 }, { x: 13, y: 12 })).toBe(false);
    expect(isDrag({ x: 10, y: 10 }, { x: 40, y: 10 })).toBe(true);
  });

  it("pushClick drops a repeat on the same element within the window, keeps others", () => {
    const list: PageClick[] = [];
    pushClick(list, click(0, "a"));
    pushClick(list, click(100, "a")); // same click seen twice (pointer + keyboard)
    pushClick(list, click(200, "b"));
    pushClick(list, click(5000, "b")); // a real second click later
    expect(list.map((c) => [c.t, c.elementPath])).toEqual([[0, "a"], [200, "b"], [5000, "b"]]);
  });

  it("cleanSelection trims, collapses runs of spaces, caps length, null when empty", () => {
    expect(cleanSelection("  Charts   refresh \n\n  as rows land.  ")).toBe("Charts refresh\nas rows land.");
    expect(cleanSelection(" \n ")).toBeNull();
    expect(cleanSelection(null)).toBeNull();
    expect(cleanSelection("x".repeat(5000))!.length).toBe(2000);
  });

  it("elementOf: an element itself, a text node's parent", () => {
    const el = { nodeType: 1, parentElement: null, tagName: "P" };
    const parent = { tagName: "H3" } as never;
    expect(elementOf(el as never)).toBe(el);
    expect(elementOf({ nodeType: 3, parentElement: parent })).toBe(parent);
    expect(elementOf(null)).toBeNull();
  });
});
