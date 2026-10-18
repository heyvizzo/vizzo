import { describe, expect, it } from "vitest";
import { domPath, pickAttrs, shortSelector } from "./details.ts";
import type { ElLike } from "./dom.ts";

const el = (tagName: string, attrs: Record<string, string> = {}, parent: ElLike | null = null): ElLike => ({
  tagName, id: attrs.id ?? "", parentElement: parent, children: [], textContent: "", getAttribute: (n) => attrs[n] ?? null,
});

describe("element paths", () => {
  const html = el("HTML");
  const body = el("BODY", {}, html);
  const app = el("DIV", { id: "app" }, body);
  const meta = el("DIV", { class: "header-meta" }, app);
  const span = el("SPAN", { class: "muted md:text-sm", "data-testid": "own-role" }, meta);

  it("short selector: parent and element, CSS-safe classes only", () => {
    expect(shortSelector(span)).toBe("div.header-meta > span.muted");
    expect(shortSelector(app)).toBe("div#app");
  });

  it("DOM path from body", () => {
    expect(domPath(span)).toBe("body > div#app > div.header-meta > span.muted");
  });

  it("DOM path tells siblings of the same tag apart", () => {
    const list = el("UL", { class: "cards" }, app);
    const items = [el("LI", { class: "card" }, list), el("LI", { class: "card" }, list)];
    Object.assign(list, { children: items });
    const solo = el("P", {}, items[1]!);
    Object.assign(items[1]!, { children: [solo] });
    expect(domPath(items[0]!)).toBe("body > div#app > ul.cards > li.card:nth-of-type(1)");
    expect(domPath(solo)).toBe("body > div#app > ul.cards > li.card:nth-of-type(2) > p");
  });

  it("picks the interesting attributes", () => {
    expect(pickAttrs(span)).toEqual({ "data-testid": "own-role" });
  });
});
