// Checks that the demo page's data-source attributes point at their own line, and that the
// fixture copies Opus reads match the page the cursor lab renders.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const DEMO = "web/cursor/demo/demo.html";

describe("demo page fixture", () => {
  const html = read("../../web/cursor/demo/demo.html");
  const lines = html.split("\n");

  it("every data-source points at the line it is on", () => {
    let count = 0;
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/data-source="([^"]*)"/g)) {
        count++;
        expect(m[1], `line ${i + 1}`).toBe(`${DEMO}:${i + 1}`);
      }
    });
    expect(count).toBeGreaterThan(30);
  });

  it("every element with data-source also has a data-label", () => {
    for (const [i, line] of lines.entries()) {
      const tags = line.match(/<[a-z][^>]*data-source=[^>]*>/g) ?? [];
      for (const tag of tags) expect(tag, `line ${i + 1}`).toMatch(/data-label="[^"]+"/);
    }
  });

  it("has the elements the benchmark utterances point at", () => {
    for (const label of ["Site header", "Main navigation", "Get started button", "Feature card grid", "Signup form", "Pricing table"]) {
      expect(html).toContain(`data-label="${label}"`);
    }
  });

  for (const f of ["demo.html", "demo.css", "demo.ts"]) {
    it(`server/fixtures-context/${f} is identical to web/cursor/demo/${f}`, () => {
      expect(read(`./${f}`)).toBe(read(`../../web/cursor/demo/${f}`));
    });
  }

  it("DECISIONS.md cites the right lines", () => {
    const decisions = read("./DECISIONS.md");
    const lineOf = (needle: string): number => lines.findIndex((l) => l.includes(needle)) + 1;
    expect(decisions).toContain(`demo.html:${lineOf('class="card-grid"')}`);
    expect(decisions).toContain(`demo.html:${lineOf('class="site-header"')}`);
    expect(decisions).toContain(`demo.html:${lineOf('class="cta"')}`);
  });
});
