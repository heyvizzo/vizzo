import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown.ts";

const text = (v: string) => ({ t: "text", v });

describe("markdown inline", () => {
  it("code, bold, italic, strikethrough", () => {
    expect(parseInline("a `x*y` **b** *c* ~~d~~")).toEqual([
      text("a "), { t: "code", v: "x*y" }, text(" "), { t: "strong", c: [text("b")] }, text(" "),
      { t: "em", c: [text("c")] }, text(" "), { t: "del", c: [text("d")] },
    ]);
  });

  it("nested emphasis", () => {
    expect(parseInline("**a *b* c**")).toEqual([{ t: "strong", c: [text("a "), { t: "em", c: [text("b")] }, text(" c")] }]);
    expect(parseInline("*a **b***")).toEqual([{ t: "em", c: [text("a "), { t: "strong", c: [text("b")] }] }]);
  });

  it("leaves snake_case, lone stars and arithmetic alone", () => {
    expect(parseInline("my_var_name and 2 * 3 * 4")).toEqual([text("my_var_name and 2 * 3 * 4")]);
    expect(parseInline("**not closed")).toEqual([text("**not closed")]);
  });

  it("delimiters inside code don't close emphasis", () => {
    expect(parseInline("**see `a**b`**")).toEqual([{ t: "strong", c: [text("see "), { t: "code", v: "a**b" }] }]);
  });

  it("links, autolinks and bare URLs", () => {
    expect(parseInline("[the docs](https://x.dev/a_(b)) and https://y.dev/p.")).toEqual([
      { t: "link", href: "https://x.dev/a_(b)", c: [text("the docs")] }, text(" and "),
      { t: "link", href: "https://y.dev/p", c: [text("https://y.dev/p")] }, text("."),
    ]);
    expect(parseInline("<https://z.dev>")).toEqual([{ t: "link", href: "https://z.dev", c: [text("https://z.dev")] }]);
    expect(parseInline("[`file.ts`](web/file.ts:3)")).toEqual([{ t: "link", href: "web/file.ts:3", c: [{ t: "code", v: "file.ts" }] }]);
  });

  it("soft breaks are spaces, two trailing spaces a hard break, escapes are literal", () => {
    expect(parseInline("a\nb  \nc \\*d\\*")).toEqual([text("a b"), { t: "br" }, text("c *d*")]);
  });
});

describe("markdown blocks", () => {
  it("headings, paragraphs and rules", () => {
    expect(parseMarkdown("# Title\n\nOne\ntwo\n\n---\n## Sub ##")).toEqual([
      { t: "h", level: 1, c: [text("Title")] },
      { t: "p", c: [text("One two")] },
      { t: "hr" },
      { t: "h", level: 2, c: [text("Sub")] },
    ]);
  });

  it("fenced code keeps its text verbatim", () => {
    expect(parseMarkdown("```ts\nconst a = **b**;\n\n  x\n```\nafter")).toEqual([
      { t: "code", lang: "ts", v: "const a = **b**;\n\n  x" },
      { t: "p", c: [text("after")] },
    ]);
  });

  it("an unclosed fence runs to the end", () => {
    expect(parseMarkdown("```\nabc")).toEqual([{ t: "code", lang: "", v: "abc" }]);
  });

  it("bullet and numbered lists, nested, with lazy continuation", () => {
    expect(parseMarkdown("- one\n  more\n- two\n  1. a\n  2. b\nlazy\n\n3. x\n4. y")).toEqual([
      {
        t: "list", ordered: false, start: 1, items: [
          [{ t: "p", c: [text("one more")] }],
          [{ t: "p", c: [text("two")] }, { t: "list", ordered: true, start: 1, items: [[{ t: "p", c: [text("a")] }], [{ t: "p", c: [text("b lazy")] }]] }],
        ],
      },
      { t: "list", ordered: true, start: 3, items: [[{ t: "p", c: [text("x")] }], [{ t: "p", c: [text("y")] }]] },
    ]);
  });

  it("a loose list (blank lines between items) stays one list", () => {
    const blocks = parseMarkdown("1. a\n\n2. b\n\n   detail\n\nafter");
    expect(blocks).toEqual([
      { t: "list", ordered: true, start: 1, items: [[{ t: "p", c: [text("a")] }], [{ t: "p", c: [text("b")] }, { t: "p", c: [text("detail")] }]] },
      { t: "p", c: [text("after")] },
    ]);
  });

  it("a paragraph ends at a list, heading or fence", () => {
    expect(parseMarkdown("Changes:\n- a\n- b").map((b) => b.t)).toEqual(["p", "list"]);
    expect(parseMarkdown("Text\n```\nx\n```").map((b) => b.t)).toEqual(["p", "code"]);
  });

  it("quotes", () => {
    expect(parseMarkdown("> a\n> - b")).toEqual([
      { t: "quote", c: [{ t: "p", c: [text("a")] }, { t: "list", ordered: false, start: 1, items: [[{ t: "p", c: [text("b")] }]] }] },
    ]);
  });

  it("tables with alignment, escaped pipes and code cells", () => {
    expect(parseMarkdown("| File | Lines |\n|:--|--:|\n| `a|b` | 3 |\n| x \\| y |")).toEqual([{
      t: "table", align: ["left", "right"], head: [[text("File")], [text("Lines")]],
      rows: [[[{ t: "code", v: "a|b" }], [text("3")]], [[text("x | y")], []]],
    }]);
  });

  it("CRLF and tabs", () => {
    expect(parseMarkdown("- a\r\n\t- b")).toEqual([
      { t: "list", ordered: false, start: 1, items: [[{ t: "p", c: [text("a")] }, { t: "list", ordered: false, start: 1, items: [[{ t: "p", c: [text("b")] }]] }]] },
    ]);
  });
});
