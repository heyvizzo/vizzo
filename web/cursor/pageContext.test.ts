import { describe, expect, it } from "vitest";
import type { PageClick, PageHighlight } from "../../shared/protocol.ts";
import { addClick, addHighlight, cleanSelection, clickKind, elementOf, isDrag, overlaps, type RawClick, type Span } from "./pageContext.ts";

const raw = (t: number, elementPath: string | null, x = 0): RawClick => ({ t, tUp: t + 80, x, y: 0, elementPath, dataSource: null, label: null, container: null });
const hl = (tStart: number, t: number, text = "x"): PageHighlight => ({ text, tStart, t, elementPath: "p", dataSource: null, label: null });

describe("pageContext helpers", () => {
  it("isDrag: movement beyond a few px between down and up", () => {
    expect(isDrag({ x: 10, y: 10 }, { x: 13, y: 12 })).toBe(false);
    expect(isDrag({ x: 10, y: 10 }, { x: 40, y: 10 })).toBe(true);
  });

  it("clickKind: 1 single, 2 double, 3 triple, 4+ multi", () => {
    expect([1, 2, 3, 4, 7].map(clickKind)).toEqual(["single", "double", "triple", "multi", "multi"]);
  });

  it("addClick keeps each click's coords through a group", () => {
    const at = (x: number) => ({ container: { size: { width: 10, height: 10 }, at: { px: { x, y: 0 }, pct: { x: x * 10, y: 0 } } }, page: { size: { width: 100, height: 100 }, at: { px: { x, y: 0 }, pct: { x, y: 0 } } } });
    const list: PageClick[] = [];
    addClick(list, { ...raw(0, "h3"), coords: at(1) });
    addClick(list, { ...raw(200, "h3"), coords: at(2) });
    addClick(list, raw(300, "h3")); // no coords: the group still counts it, but coords only has the two that had them
    expect(list[0]!.times).toHaveLength(3);
    expect(list[0]!.coords).toEqual([at(1), at(2)]);
  });

  it("addClick groups rapid clicks on the same element and keeps every timestamp", () => {
    const list: PageClick[] = [];
    for (const t of [0, 200, 380]) addClick(list, raw(t, "h3")); // triple click
    addClick(list, raw(1500, "h3")); // too late: a new single click
    for (const t of [3000, 3150, 3300, 3450, 3600]) addClick(list, raw(t, "button")); // 5 rapid clicks
    addClick(list, raw(3700, "td")); // other element: new event
    expect(list.map((c) => [c.kind, c.count, c.elementPath])).toEqual([
      ["triple", 3, "h3"], ["single", 1, "h3"], ["multi", 5, "button"], ["single", 1, "td"],
    ]);
    expect(list[0]!.times).toEqual([0, 200, 380]);
    expect([list[0]!.t, list[0]!.tEnd]).toEqual([0, 460]);
    expect(list[2]!.times).toHaveLength(5);
  });

  it("addClick: same element but far apart on screen starts a new event", () => {
    const list: PageClick[] = [];
    addClick(list, raw(0, "table", 10));
    addClick(list, raw(150, "table", 300));
    expect(list.map((c) => c.kind)).toEqual(["single", "single"]);
  });

  it("addHighlight: separate highlights stay separate; a refinement of the same gesture replaces; repeats are ignored", () => {
    const list: { h: PageHighlight; span: Span }[] = [];
    expect(addHighlight(list, hl(0, 300, "Live"), { start: 10, end: 14 })).toBe("added"); // double-click word
    expect(addHighlight(list, hl(400, 500, "Live queries"), { start: 10, end: 22 })).toBe("replaced"); // triple → line
    expect(addHighlight(list, hl(2000, 2600, "Team"), { start: 90, end: 94 })).toBe("added"); // a second row
    expect(addHighlight(list, hl(2700, 2800, "Team"), { start: 90, end: 94 })).toBe("ignored");
    expect(addHighlight(list, hl(5000, 5400, "Team plan"), { start: 90, end: 99 })).toBe("added"); // overlapping but much later
    expect(list.map((x) => x.h.text)).toEqual(["Live queries", "Team", "Team plan"]);
    expect(list[0]!.h.tStart).toBe(0);
    expect(overlaps({ start: 0, end: 5 }, { start: 5, end: 9 })).toBe(false);
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
