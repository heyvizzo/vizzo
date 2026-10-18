import { describe, expect, it } from "vitest";
import { formatElementDetails, referencedElements } from "./elementDetails.ts";
import type { CursorRest, CursorSample, ElementDetails, PointingTarget } from "./protocol.ts";

const details: ElementDetails = {
  selector: "div.header-meta > span.muted",
  domPath: "body > div#app > main#main-content > div.page-header > div > div.header-meta > span.muted",
  tag: "span",
  classes: ["muted"],
  attrs: { "data-testid": "own-role" },
  text: "Your role: Owner · ceiling 200",
  bounds: { x: 977, y: 171, width: 202, height: 23 },
  viewport: { width: 1238, height: 779 },
  styles: { display: "block", margin: "0px", color: "rgb(163, 172, 164)", border: "0px none rgb(163, 172, 164)", "font-size": "15px" },
  html: '<span class="muted" data-testid="own-role">Your role: Owner · ceiling 200</span>',
};
const PATH = "html > body > div#app > span";
const sample = (t: number, d?: ElementDetails): CursorSample => ({ t, x: 0, y: 0, scrollX: 0, scrollY: 0, elementPath: PATH, dataSource: null, label: "Your role", ...(d ? { details: d } : {}) });

describe("referencedElements", () => {
  const samples = [sample(1, details), sample(2), sample(3)];
  const targets: PointingTarget[] = [
    { word: "this", wordStart: 0.5, algorithm: "atStart", sample: sample(2), ref: 1 },
    { word: "this", wordStart: 0.5, algorithm: "dwellMode", sample: sample(3), ref: 1 },
  ];
  const rests: CursorRest[] = [{ ref: 1, tStart: 1, tEnd: 3, sample: sample(2), wordIndex: null, whole: true }];

  it("finds details by path and lists an element once with all its refs", () => {
    const els = referencedElements(targets, rests, samples);
    expect(els).toHaveLength(1);
    expect(els[0]!.refs).toEqual(["[1]", "[@1]"]);
    expect(els[0]!.details).toBe(details);
  });

  it("is empty without details", () => {
    expect(referencedElements(targets, rests, [sample(1)])).toEqual([]);
    expect(formatElementDetails([], true)).toBe("");
  });

  it("formats a compact line and a full block", () => {
    const els = referencedElements(targets, [], samples);
    expect(formatElementDetails(els, false)).toBe(
      "Elements referenced above (viewport 1238×779, bounds in viewport px):\n"
      + '[1] <span> "Your role: Owner · ceiling 200" — `div.header-meta > span.muted`, data-testid="own-role", 202×23 at (977, 171)',
    );
    const full = formatElementDetails(els, true);
    expect(full).toContain("   DOM path: `body > div#app > main#main-content");
    expect(full).toContain("   Computed styles: display: block; color: rgb(163, 172, 164); font-size: 15px");
    expect(full).toContain('   HTML: <span class="muted" data-testid="own-role">');
    const react = { ...details, react: { chain: ["HeaderMeta", "PageHeader"], props: 'role: "owner"', source: "resources/js/HeaderMeta.tsx:31", sourceExact: false } };
    const withReact = formatElementDetails([{ refs: ["[1]"], details: react }], true);
    expect(withReact).toContain("   React component: <HeaderMeta> in PageHeader");
    expect(withReact).toContain('   Props of <HeaderMeta>: role: "owner"');
    expect(withReact).toContain("   JSX written at: resources/js/HeaderMeta.tsx:31 (line as served by the dev server: may be off by a few)");
    expect(formatElementDetails([{ refs: ["[1]"], details: react }], false)).toContain("`div.header-meta > span.muted`, in <HeaderMeta>,");
  });
});
