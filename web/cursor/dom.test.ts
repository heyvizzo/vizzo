import { describe, expect, it } from "vitest";
import { accessibleName, cssPath, describeElement, type ElLike } from "./dom.ts";

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
  cards[1]!.add(h3, new El("P", {}, "Fast"));
  const cta = new El("BUTTON", { id: "cta", "data-source": "demo.html:42" }, " Get   started ");
  const weird = new El("SPAN", { id: "1 bad id" }, "x");
  main.add(...cards, cta, weird);
  root.add(main);
  const outside = new El("ASIDE", {}, "lab ui");
  body.add(root, outside);
  html.add(body);
  return { html, root, cards, h3, cta, weird, outside, main };
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
  it("uses the closest data-source and data-label", () => {
    const { h3, root } = tree();
    expect(describeElement(h3, root)).toEqual({
      elementPath: "div#demo-root > main > article:nth-of-type(2) > h3", dataSource: "demo.html:12", label: "Card 2",
    });
  });

  it("falls back to the accessible name of the data-source element", () => {
    const { cta, root } = tree();
    expect(describeElement(cta, root)).toMatchObject({ dataSource: "demo.html:42", label: "Get started" });
  });

  it("is all-null outside the root or for null", () => {
    const { outside, root } = tree();
    expect(describeElement(outside, root)).toEqual({ elementPath: null, dataSource: null, label: null });
    expect(describeElement(null, root).elementPath).toBeNull();
  });

  it("accessibleName prefers aria-label, alt, title, placeholder", () => {
    expect(accessibleName(new El("INPUT", { placeholder: "Email" }))).toBe("Email");
    expect(accessibleName(new El("IMG", { alt: "Logo", title: "t" }))).toBe("Logo");
    expect(accessibleName(new El("BUTTON", { "aria-label": "Close" }, "x"))).toBe("Close");
    expect(accessibleName(new El("DIV"))).toBeNull();
    expect(accessibleName(new El("P", {}, "a".repeat(200)))!.length).toBe(80);
  });
});
