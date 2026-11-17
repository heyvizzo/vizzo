import { describe, expect, it } from "vitest";
import { GESTURE_GAP_MS, SWIPE_THRESHOLD, buttonDir, createSwipeTracker, type NavDir, type WheelSample } from "./historyNav.ts";

const both = () => true;
/** A gesture of `n` equal wheel events, 16 ms apart, starting at t0. */
function swipe(tracker: ReturnType<typeof createSwipeTracker>, n: number, dx: number, opts: Partial<WheelSample> & { t0?: number; dy?: number } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(tracker.wheel({ dx, dy: opts.dy ?? 0, t: (opts.t0 ?? 0) + i * 16, taken: opts.taken ?? false, can: opts.can ?? both }));
  return out;
}

describe("swipe tracker", () => {
  it("fingers right (dx < 0) go back once the travel passes the threshold, and only once", () => {
    const updates = swipe(createSwipeTracker(), 40, -20);
    const navs = updates.filter((u) => u.type === "navigate");
    expect(navs).toEqual([{ type: "navigate", dir: "back" }]);
    expect(updates.indexOf(navs[0]!)).toBe(SWIPE_THRESHOLD / 20 - 1);
    expect(updates[0]).toEqual({ type: "progress", dir: "back", progress: 20 / SWIPE_THRESHOLD });
  });

  it("fingers left (dx > 0) go forward", () => {
    expect(swipe(createSwipeTracker(), 20, 20).find((u) => u.type === "navigate")).toEqual({ type: "navigate", dir: "forward" });
  });

  it("ignores a gesture that starts where the page can scroll, or the page took", () => {
    const t = createSwipeTracker();
    expect(swipe(t, 20, -20, { taken: true }).every((u) => u.type === "none")).toBe(true);
  });

  it("ignores a gesture when history has nothing that way", () => {
    const can = (dir: NavDir) => dir === "forward";
    expect(swipe(createSwipeTracker(), 20, -20, { can }).every((u) => u.type === "none")).toBe(true);
  });

  it("ignores vertical scrolling, and cancels a swipe that turns vertical", () => {
    expect(swipe(createSwipeTracker(), 20, 5, { dy: 30 }).every((u) => u.type === "none")).toBe(true);
    const t = createSwipeTracker();
    swipe(t, 3, -20);
    const turned = swipe(t, 10, 0, { dy: 30, t0: 48 });
    expect(turned[2]).toEqual({ type: "progress", dir: "back", progress: 0 });
    expect(turned.some((u) => u.type === "navigate")).toBe(false);
  });

  it("a pause ends the gesture: a new one can start, momentum without a pause can't", () => {
    const t = createSwipeTracker();
    swipe(t, 20, -20);
    // Momentum right after the navigation: ignored.
    expect(swipe(t, 20, -20, { t0: 320 }).every((u) => u.type === "none")).toBe(true);
    // After a pause: a new gesture.
    expect(swipe(t, 20, -20, { t0: 320 + 20 * 16 + GESTURE_GAP_MS + 1 }).some((u) => u.type === "navigate")).toBe(true);
  });
});

/** Feeds `deltas` (dx per event, 16 ms apart) from t0; returns the updates. */
function feed(tracker: ReturnType<typeof createSwipeTracker>, deltas: number[], t0: number) {
  return deltas.map((dx, i) => tracker.wheel({ dx, dy: 0, t: t0 + i * 16, taken: false, can: both }));
}
/** macOS-like: a finger swipe ramping up, then momentum decaying. */
const fingers = [-2, -6, -14, -24, -34, -40, -40, -36];
const momentum = Array.from({ length: 40 }, (_, i) => -Math.round(36 * 0.9 ** (i + 1)));

describe("swipes in a row", () => {
  it("a new swipe during the last one's momentum goes back again", () => {
    const t = createSwipeTracker();
    const first = feed(t, [...fingers, ...momentum.slice(0, 6)], 0);
    expect(first.filter((u) => u.type === "navigate")).toHaveLength(1);
    // The fingers come back mid-momentum (no pause): the rising deltas start a new swipe.
    const second = feed(t, [...momentum.slice(6, 9), ...fingers, ...fingers], (8 + 6) * 16);
    expect(second.filter((u) => u.type === "navigate")).toHaveLength(1);
  });

  it("momentum alone, however long, doesn't", () => {
    const t = createSwipeTracker();
    expect(feed(t, [...fingers, -40], 0).filter((u) => u.type === "navigate")).toHaveLength(1);
    expect(feed(t, momentum, 9 * 16).filter((u) => u.type === "navigate")).toHaveLength(0);
  });

  it("a page opened by a swipe ignores that swipe's momentum, then takes the next swipe", () => {
    const t = createSwipeTracker();
    t.momentum(0);
    expect(feed(t, momentum.slice(10), 16).every((u) => u.type === "none")).toBe(true);
    expect(feed(t, [...fingers, ...fingers], 16 * 31).some((u) => u.type === "navigate")).toBe(true);
  });
});

describe("side buttons", () => {
  it("3 is back, 4 is forward, others nothing", () => {
    expect([0, 1, 2, 3, 4].map(buttonDir)).toEqual([null, null, null, "back", "forward"]);
  });
});
