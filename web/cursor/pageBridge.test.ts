import { describe, expect, it } from "vitest";
import type { CursorSample, PageEvents } from "../../shared/protocol.ts";
import { createRemotePage, mergePageEvents, shiftPageEvents, type PageBridge, type PageCmd, type PageEventsMsg } from "./pageBridge.ts";

const el = { elementPath: "html > body > a", dataSource: null, label: "Docs" };
const sample = (t: number): CursorSample => ({ t, x: 1, y: 2, scrollX: 0, scrollY: 0, ...el });
const events = (t: number): PageEvents => ({
  clicks: [{ ...el, kind: "double", count: 2, t, tEnd: t + 150, times: [t, t + 100], x: 1, y: 2 }],
  preselected: { ...el, t, text: "pre" },
  highlights: [{ ...el, text: "word", via: "double-click", tStart: t, t: t + 150 }],
});

function fakeBridge() {
  const sent: PageCmd[] = [];
  let samples: (s: CursorSample[]) => void = () => {};
  let evs: (m: PageEventsMsg) => void = () => {};
  const bridge: PageBridge = { send: (c) => sent.push(c), onSamples: (cb) => (samples = cb), onEvents: (cb) => (evs = cb) };
  return { bridge, sent, samples: (s: CursorSample[]) => samples(s), events: (m: PageEventsMsg) => evs(m) };
}

describe("shiftPageEvents", () => {
  it("shifts every timestamp", () => {
    expect(shiftPageEvents(events(10), 1000)).toEqual(events(1010));
  });
});

describe("mergePageEvents", () => {
  it("concatenates clicks and highlights in document order and keeps the first preselection", () => {
    const m = mergePageEvents([events(1), { ...events(5), preselected: null }]);
    expect(m.clicks.map((c) => c.t)).toEqual([1, 5]);
    expect(m.highlights.map((h) => h.t)).toEqual([151, 155]);
    expect(m.preselected?.t).toBe(1);
    expect(mergePageEvents([])).toEqual({ clicks: [], preselected: null, highlights: [] });
  });
});

describe("createRemotePage", () => {
  const ORIGIN = 1_700_000_000_000;

  it("converts between the chat clock and epoch ms", async () => {
    const f = fakeBridge();
    const page = createRemotePage(f.bridge, ORIGIN, 50);
    f.samples([sample(ORIGIN + 100), sample(ORIGIN + 200)]);
    expect(page.range(150).map((s) => s.t)).toEqual([200]);

    page.start(90);
    expect(f.sent[0]).toEqual({ type: "start", t: ORIGIN + 90 });
    const stopped = page.stop();
    f.events({ doc: "a", final: true, events: events(ORIGIN + 120) });
    expect(await stopped).toEqual(events(120));
  });

  it("merges the documents of one turn and resolves on the final reply", async () => {
    const f = fakeBridge();
    const page = createRemotePage(f.bridge, 0, 10_000);
    page.start(0);
    f.events({ doc: "a", final: false, events: events(1) });
    f.events({ doc: "a", final: false, events: events(2) }); // a later snapshot replaces the earlier one
    f.events({ doc: "b", final: false, events: { ...events(5), preselected: null } });
    const stopped = page.stop();
    f.events({ doc: "b", final: true, events: { ...events(6), preselected: null } });
    const ev = await stopped;
    expect(ev.clicks.map((c) => c.t)).toEqual([2, 6]);
    expect(ev.preselected?.t).toBe(2);
  });

  it("gives up waiting when the page doesn't answer, and ignores events outside a turn", async () => {
    const f = fakeBridge();
    const page = createRemotePage(f.bridge, 0, 10);
    f.events({ doc: "a", final: false, events: events(1) });
    page.start(0);
    expect(await page.stop()).toEqual({ clicks: [], preselected: null, highlights: [] });
    f.events({ doc: "a", final: true, events: events(3) });
    page.clear();
    expect(f.sent.map((c) => c.type)).toEqual(["start", "stop", "clear"]);
  });
});
