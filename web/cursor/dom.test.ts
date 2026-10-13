import { describe, expect, it } from "vitest";
import { accessibleName, cssPath, describeElement, hasOwnText, type ElLike } from "./dom.ts";

class El implements ElLike {
  parentElement: El | null = null;
  children: El[] = [];
  constructor(public tagName: string, public attrs: Record<string, string> = {}, public text = "") {}
  get id() { return this.attrs.id ?? ""; }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(" "); }
  getAttribute(n: string) { return this.attrs[n] ?? null; }
  add(...cs: El[]) {
    for (const c of cs) {
      c.parentElement = this;
      this.children.push(c);
    }
    return this;
  }
}

function tree() {
  const html = new El("HTML");
  const body = new El("BODY");
  const root = new El("DIV", { id: "demo-root" });
  const main = new El("MAIN");
  const cards = [1, 2, 3].map((i) => new El("ARTICLE", { "data-source": `demo.html:${10 + i}`, "data-label": `Card ${i}` }));
  const h3 = new El("H3", {}, "Speed");
  const para = new El("P", {}, "Fast   queries,\n  everywhere.");
  const wrap = new El("DIV", { class: "card-inner" });
  const icon = new El("SPAN", { class: "icon" });
  wrap.add(icon);
  cards[1]!.add(h3, para, wrap);
  const cta = new El("BUTTON", { id: "cta", "data-source": "demo.html:42" }, " Get   started ");
  const ctaIcon = new El("SVG");
  cta.add(ctaIcon);
  const weird = new El("SPAN", { id: "1 bad id" }, "x");
  // A labeled table: a header cell with its own data-source, one without, and a labeled body row.
  const table = new El("TABLE", { "data-source": "demo.html:60", "data-label": "Pricing table" });
  const thead = new El("THEAD");
  const htr = new El("TR");
  const thPlain = new El("TH", {}, "Plan");
  const th = new El("TH", { "data-source": "demo.html:63", "data-label": "Column: Price" }, "Price / month");
  htr.add(thPlain, th);
  thead.add(htr);
  const tbody = new El("TBODY");
  const row = new El("TR", { "data-source": "demo.html:70", "data-label": "Row: Team" });
  const td = new El("TD", {}, "$49");
  row.add(new El("TD", {}, "Team"), td);
  tbody.add(row);
  table.add(thead, tbody);
  const bare = new El("DIV", { class: "spacer" });
  main.add(...cards, cta, weird, table, bare);
  root.add(main);
  const outside = new El("ASIDE", {}, "lab ui");
  body.add(root, outside);
  html.add(body);
  return { root, h3, para, wrap, icon, cta, ctaIcon, weird, th, thPlain, row, td, bare, outside };
}

describe("cssPath", () => {
  it("builds a stable nth-of-type path up to the root id", () => {
    const { h3, root } = tree();
    expect(cssPath(h3, root)).toBe("div#demo-root > main > article:nth-of-type(2) > h3");
  });

  it("stops at the nearest safe id", () => {
    const { cta, root } = tree();
    expect(cssPath(cta, root)).toBe("button#cta");
  });

  it("ignores ids that aren't CSS-safe", () => {
    const { weird, root } = tree();
    expect(cssPath(weird, root)).toBe("div#demo-root > main > span");
  });

  it("returns null outside the root, and a full path without a root", () => {
    const { outside, root, h3 } = tree();
    expect(cssPath(outside, root)).toBeNull();
    expect(cssPath(outside)).toBe("html > body > aside");
    expect(cssPath(h3)).toBe("div#demo-root > main > article:nth-of-type(2) > h3");
  });
});

describe("describeElement", () => {
  it("card title → the title, with the card as container and the card's data-source", () => {
    const { h3, root } = tree();
    expect(describeElement(h3, root)).toEqual({
      elementPath: "div#demo-root > main > article:nth-of-type(2) > h3", dataSource: "demo.html:12", label: "Speed", container: "Card 2",
    });
  });

  it("plain card body → the paragraph, whitespace collapsed", () => {
    const { para, root } = tree();
    expect(describeElement(para, root)).toMatchObject({
      elementPath: "div#demo-root > main > article:nth-of-type(2) > p", label: "Fast queries, everywhere.", container: "Card 2",
    });
  });

  it("table header cell → the th (own data-source if any), container = the table", () => {
    const { th, thPlain, root } = tree();
    expect(describeElement(th, root)).toMatchObject({ dataSource: "demo.html:63", label: "Price / month", container: "Pricing table" });
    expect(describeElement(th, root).elementPath).toMatch(/> th:nth-of-type\(2\)$/);
    expect(describeElement(thPlain, root)).toMatchObject({ dataSource: "demo.html:60", label: "Plan", container: "Pricing table" });
  });

  it("table cell → the td, container = the labeled row", () => {
    const { td, root } = tree();
    expect(describeElement(td, root)).toMatchObject({ dataSource: "demo.html:70", label: "$49", container: "Row: Team" });
  });

  it("button, and an icon inside it → the button", () => {
    const { cta, ctaIcon, root } = tree();
    const want = { elementPath: "button#cta", dataSource: "demo.html:42", label: "Get started", container: null };
    expect(describeElement(cta, root)).toEqual(want);
    expect(describeElement(ctaIcon, root)).toEqual(want);
  });

  it("bare wrapper → walks up to the nearest meaningful element (here the labeled card)", () => {
    const { icon, wrap, root } = tree();
    const want = { elementPath: "div#demo-root > main > article:nth-of-type(2)", dataSource: "demo.html:12", label: "Card 2", container: null };
    expect(describeElement(icon, root)).toEqual(want);
    expect(describeElement(wrap, root)).toEqual(want);
  });

  it("nothing meaningful up to the root → the hit element, unlabeled", () => {
    const { bare, root } = tree();
    expect(describeElement(bare, root)).toEqual({ elementPath: "div#demo-root > main > div", dataSource: null, label: null, container: null });
  });

  it("a row gap → the labeled row; a span with its own text counts", () => {
    const { row, weird, root } = tree();
    expect(describeElement(row, root)).toMatchObject({ label: "Row: Team", container: "Pricing table" });
    expect(describeElement(weird, root)).toMatchObject({ label: "x" });
  });

  it("controls and images use their name; long text is truncated to 60 chars", () => {
    const form = new El("FORM", { "data-label": "Signup form" });
    const input = new El("INPUT", { placeholder: "you@company.com", "data-label": "Email input" });
    const img = new El("IMG", { alt: "Logo" });
    const p = new El("P", {}, "word ".repeat(40));
    form.add(input, img, p);
    expect(describeElement(input, form)).toMatchObject({ label: "Email input", container: "Signup form" });
    expect(describeElement(img, form).label).toBe("Logo");
    const long = describeElement(p, form).label!;
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
  });

  it("never reports a container equal to the label", () => {
    const card = new El("ARTICLE", { "data-label": "Alerts" });
    const h = new El("H3", {}, "Alerts");
    card.add(h);
    expect(describeElement(h, card)).toMatchObject({ label: "Alerts", container: null });
  });

  it("is all-null outside the root or for null", () => {
    const { outside, root } = tree();
    expect(describeElement(outside, root)).toEqual({ elementPath: null, dataSource: null, label: null, container: null });
    expect(describeElement(null, root).elementPath).toBeNull();
  });

  it("hasOwnText distinguishes own text from text in children", () => {
    expect(hasOwnText(new El("DIV").add(new El("B", {}, "$5")))).toBe(false);
    expect(hasOwnText(new El("DIV", {}, "Price").add(new El("B", {}, "$5")))).toBe(true);
    expect(hasOwnText(new El("DIV", {}, "   "))).toBe(false);
  });

  it("accessibleName prefers aria-label, alt, title, placeholder", () => {
    expect(accessibleName(new El("INPUT", { placeholder: "Email" }))).toBe("Email");
    expect(accessibleName(new El("IMG", { alt: "Logo", title: "t" }))).toBe("Logo");
    expect(accessibleName(new El("BUTTON", { "aria-label": "Close" }, "x"))).toBe("Close");
    expect(accessibleName(new El("DIV"))).toBeNull();
    expect(accessibleName(new El("P", {}, "a".repeat(200)))!.length).toBe(60);
  });
});
