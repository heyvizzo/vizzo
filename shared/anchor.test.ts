import { describe, expect, it } from "vitest";
import { anchorTitle, inferAnchor, matchAnchor, type AnchorInput } from "./anchor.ts";
import type { CursorRest, CursorSample, ElementDetails, PointingTarget } from "./protocol.ts";
import type { ThreadAnchor, ThreadInfo } from "./threads.ts";

const RED = "body > main > section.hero > button.cta.red";
const BLUE = "body > main > section.hero > button.cta.blue";

const details = (o: Partial<ElementDetails> = {}): ElementDetails => ({
  selector: "section.hero > button.cta.red", domPath: RED, tag: "button", classes: ["cta", "red"], attrs: { role: "button" },
  text: "Get started", bounds: { x: 100, y: 200, width: 120, height: 40 }, viewport: { width: 1280, height: 800 },
  styles: {}, html: "<button>", ...o,
});
const sample = (o: Partial<CursorSample> = {}): CursorSample => ({
  t: 1000, x: 150, y: 220, scrollX: 0, scrollY: 300, elementPath: "main > section.hero > button:nth-of-type(1)",
  dataSource: "index.html:12", label: "Get started", ...o,
});
const rest = (s: CursorSample, tStart: number, tEnd: number, whole = false): CursorRest => ({ ref: 1, tStart, tEnd, sample: s, wordIndex: null, whole });
const input = (o: Partial<AnchorInput>): AnchorInput => ({ words: [], pointing: [], rests: [], samples: [], pageUrl: "http://localhost:5173/index.html#top", ...o });

const BLUE_SAMPLE = sample({ elementPath: "main > section.hero > button:nth-of-type(2)", label: "Learn more", dataSource: "index.html:13" });

describe("inferAnchor", () => {
  it("null when nothing was pointed at", () => {
    expect(inferAnchor(input({ samples: [sample({ elementPath: null })] }))).toBeNull();
  });

  it("the whole-utterance rest wins; bounds in document coords; page url normalized", () => {
    const red = sample({ details: details() });
    const a = inferAnchor(input({ rests: [rest(BLUE_SAMPLE, 0, 5000), rest(red, 0, 100, true)], samples: [red, BLUE_SAMPLE] }))!;
    expect(a).toEqual({
      pageUrl: "http://localhost:5173/index.html", selector: "section.hero > button.cta.red", domPath: RED, dataSource: "index.html:12",
      label: "Get started", text: "Get started", role: "button", tag: "button", bounds: { x: 100, y: 500, width: 120, height: 40 },
      point: { x: 150, y: 520 }, // the pointer on the element, document coords
    });
  });

  it("else the longest rest; details found on another sample of the same element", () => {
    const later = sample({ t: 2000 }); // no details
    const first = sample({ t: 900, scrollY: 0, details: details() });
    const a = inferAnchor(input({ rests: [rest(BLUE_SAMPLE, 0, 300), rest(later, 1000, 2000)], samples: [first, later] }))!;
    expect(a.label).toBe("Get started");
    expect(a.domPath).toBe(RED);
    expect(a.bounds.y).toBe(200); // the scroll of the sample that carried the details
  });

  it("else the first pointing word's best pick", () => {
    const p: PointingTarget[] = [
      { word: "that", wordStart: 1.5, algorithm: "dwellMode", sample: BLUE_SAMPLE },
      { word: "this", wordStart: 0.4, algorithm: "atStart", sample: BLUE_SAMPLE },
      { word: "this", wordStart: 0.4, algorithm: "dwellMode", sample: sample() },
    ];
    expect(inferAnchor(input({ pointing: p }))!.label).toBe("Get started");
  });

  it("else the last sample on an element; degrades without details", () => {
    const a = inferAnchor(input({ samples: [sample(), BLUE_SAMPLE, sample({ elementPath: null })] }))!;
    expect(a).toMatchObject({
      label: "Learn more", selector: BLUE_SAMPLE.elementPath, domPath: BLUE_SAMPLE.elementPath, text: null, role: null, tag: "button",
      bounds: { x: 150, y: 520, width: 0, height: 0 },
    });
  });
});

const anchor = (o: Partial<ThreadAnchor> = {}): ThreadAnchor => ({
  pageUrl: "http://x/index.html", selector: "section.hero > button.cta.red", domPath: RED, dataSource: "index.html:12",
  label: "Get started", text: "Get started", role: null, tag: "button", bounds: { x: 0, y: 0, width: 1, height: 1 }, ...o,
});
const thread = (threadId: string, a: ThreadAnchor, lastInteractionAt = 0): ThreadInfo => ({
  threadId, pageUrl: a.pageUrl, anchor: a, title: "", state: "idle", intent: "task", summary: "", unread: false,
  awaitingReply: false, messages: [], createdAt: 0, lastInteractionAt,
});

describe("matchAnchor", () => {
  it("same page required (the fragment doesn't count)", () => {
    expect(matchAnchor(anchor({ pageUrl: "http://x/index.html#faq" }), [thread("t1", anchor())])).toBe("t1");
    expect(matchAnchor(anchor({ pageUrl: "http://x/index.html?plan=pro" }), [thread("t1", anchor())])).toBeNull();
  });

  it("domPath, selector + text, or dataSource", () => {
    expect(matchAnchor(anchor({ selector: "x", dataSource: null }), [thread("t1", anchor())])).toBe("t1");
    expect(matchAnchor(anchor({ domPath: "other", dataSource: null }), [thread("t1", anchor())])).toBe("t1");
    expect(matchAnchor(anchor({ domPath: "other", dataSource: null, text: "Start free" }), [thread("t1", anchor())])).toBeNull();
    // Classes and text changed by the edit itself: the source line still matches.
    expect(matchAnchor(anchor({ domPath: "other", selector: "y", text: null }), [thread("t1", anchor())])).toBe("t1");
  });

  it("two elements under one data-source stay apart", () => {
    const blue = anchor({ domPath: BLUE, selector: "section.hero > button.cta.blue", label: "Learn more", text: "Learn more" });
    expect(matchAnchor(blue, [thread("t1", anchor())])).toBeNull();
  });

  it("strongest match first, then the most recently interacted", () => {
    const viaSource = thread("src", anchor({ domPath: "a", selector: "b" }), 50);
    expect(matchAnchor(anchor(), [viaSource, thread("old", anchor(), 10)])).toBe("old");
    expect(matchAnchor(anchor(), [thread("old", anchor(), 10), thread("new", anchor(), 20)])).toBe("new");
  });
});

describe("anchorTitle", () => {
  it("label + noun from the tag or role", () => {
    expect(anchorTitle(anchor())).toBe("the 'Get started' button");
    expect(anchorTitle(anchor({ tag: "a", label: "Docs" }))).toBe("the 'Docs' link");
    expect(anchorTitle(anchor({ tag: "div", role: "button", label: "Close" }))).toBe("the 'Close' button");
    expect(anchorTitle(anchor({ tag: "h2", label: null, text: "Pricing" }))).toBe("the 'Pricing' heading");
  });
  it("landmarks by their noun; no name: the noun; the label already names it", () => {
    expect(anchorTitle(anchor({ tag: "footer", label: "© 2026 Acme · Privacy · Terms · Contact us" }))).toBe("the footer");
    expect(anchorTitle(anchor({ tag: "img", label: null, text: null }))).toBe("the image");
    expect(anchorTitle(anchor({ tag: "div", label: null, text: null }))).toBe("the div element");
    expect(anchorTitle(anchor({ tag: "section", label: "Pricing section" }))).toBe("the 'Pricing section'");
  });
  it("long names are cut at a word, short overall", () => {
    const t = anchorTitle(anchor({ tag: "p", label: "Build realtime apps without managing any servers at all" }));
    expect(t).toBe("the 'Build realtime apps…' paragraph");
    expect(t.length).toBeLessThanOrEqual(45);
  });
});
