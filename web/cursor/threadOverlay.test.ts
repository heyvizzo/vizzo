import { describe, expect, it } from "vitest";
import { deleteConfirmation, markerPoint, orbPoint, panelPosition, textMatches } from "./threadOverlay.ts";

describe("textMatches", () => {
  it("matches the anchor's text, capped text by prefix, or its label", () => {
    expect(textMatches("  Get   started ", null, { text: "Get started", label: null })).toBe(true);
    expect(textMatches("Get going", null, { text: "Get started", label: null })).toBe(false);
    expect(textMatches("A long paragraph of text that goes on", null, { text: "A long paragraph of…", label: null })).toBe(true);
    expect(textMatches("", "Close dialog", { text: null, label: "Close dialog" })).toBe(true);
    expect(textMatches("x", null, { text: null, label: null })).toBe(false);
  });
});

describe("deleteConfirmation", () => {
  it.each([
    ["none", "keep", [{ label: "Delete", mode: "keep" }]],
    ["complete", "commit", [{ label: "Commit and delete", mode: "commit" }, { label: "Delete, keep uncommitted", mode: "keep" }]],
    ["incomplete", "keep", [{ label: "Delete, keep uncommitted", mode: "keep" }]],
    ["working", "keep", [{ label: "Stop and delete", mode: "keep" }]],
  ] as const)("chooses the actions and focused default for %s", (state, defaultMode, actions) => {
    expect(deleteConfirmation({ threadId: "t", state, defaultMode }).actions).toEqual(actions);
  });

  it("shows the ledger's reasons for a tied or incomplete thread", () => {
    expect(deleteConfirmation({ threadId: "t", state: "complete", defaultMode: "commit", reason: "Also has other changes." }).text).toBe("Also has other changes.");
    expect(deleteConfirmation({ threadId: "t", state: "incomplete", defaultMode: "keep", reason: "The last task was stopped." }).text).toBe("The last task was stopped.");
    expect(deleteConfirmation({ threadId: "t", state: "working", defaultMode: "keep" }).text).toMatch(/stopped part-way/);
  });

  it("can confirm queued feedback without a preview", () => {
    expect(deleteConfirmation("queued")).toEqual({ text: "Delete this feedback? It won't be sent.", actions: [{ label: "Delete", mode: "keep" }] });
  });
});

describe("panelPosition", () => {
  const view = { sx: 0, sy: 100, vw: 1000, vh: 600 };
  it("goes below the marker, its right edge just past it, inside the viewport, the tail pointing at it", () => {
    expect(panelPosition(500, 200, 300, view)).toEqual({ left: 500 + 16 - 340, top: 219, side: "below", tailRight: 11 });
    // Pushed in from the left edge: the tail slides along to the marker.
    expect(panelPosition(100, 200, 300, view)).toMatchObject({ left: 8, tailRight: 348 - 100 - 5 });
    expect(panelPosition(20, 200, 300, view).left).toBe(8);
    expect(panelPosition(2000, 200, 300, view).left).toBe(1000 - 340 - 8);
  });
  it("goes above when there's no room below", () => {
    expect(panelPosition(500, 650, 300, view)).toMatchObject({ top: 650 - 10 - 9 - 300, side: "above" });
    // No room above either: below.
    expect(panelPosition(500, 300, 500, view).top).toBe(319);
  });
});

describe("markerPoint", () => {
  const bounds = { x: 100, y: 500, width: 120, height: 40 };
  it("keeps the pointed spot's relative position as the element moves and resizes", () => {
    expect(markerPoint({ bounds, point: { x: 130, y: 510 } }, { x: 200, y: 600, width: 240, height: 80 })).toEqual({ x: 260, y: 620 });
  });
  it("clamps a point outside the element; the center without a point; the point itself without the element", () => {
    expect(markerPoint({ bounds, point: { x: 0, y: 9999 } }, bounds)).toEqual({ x: 100, y: 540 });
    expect(markerPoint({ bounds }, bounds)).toEqual({ x: 160, y: 520 });
    expect(markerPoint({ bounds, point: { x: 130, y: 510 } }, null)).toEqual({ x: 130, y: 510 });
  });
});

describe("orbPoint", () => {
  it("starts bottom center, its bottom edge 25 px above the viewport's bottom", () => {
    expect(orbPoint(null, 1000, 800)).toEqual({ x: 500, y: 800 - 25 - 39 });
  });
  it("goes where it was dragged, as fractions of the viewport", () => {
    expect(orbPoint({ x: 0.25, y: 0.5 }, 1000, 800)).toEqual({ x: 250, y: 400 });
  });
  it("stays inside the viewport", () => {
    expect(orbPoint({ x: 1, y: 0 }, 1000, 800)).toEqual({ x: 1000 - 43, y: 43 });
  });
});

describe("panelPosition with the orb's radius", () => {
  it("opens above an orb at the bottom, clear of it", () => {
    const p = panelPosition(500, 736, 300, { sx: 0, sy: 0, vw: 1000, vh: 800 }, 39);
    expect(p.side).toBe("above");
    expect(p.top + 300).toBeLessThan(736 - 39);
  });
});
