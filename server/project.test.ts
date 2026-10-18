import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectDir, projectFile, setProjectDir } from "./project.ts";

describe("project folder", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "project-test-"));
    writeFileSync(join(dir, "demo.html"), "<h1>Hi</h1>");
    writeFileSync(join(dir, "demo.css"), "h1 { color: red }");
    writeFileSync(join(dir, "demo.ts"), "const x: number = 1;\nexport { x };\n");
    writeFileSync(join(dir, "secret.env"), "KEY=1");
  });
  afterEach(() => setProjectDir(null));

  it("must be an existing folder", () => {
    expect(() => setProjectDir(join(dir, "demo.html"))).toThrow(/not a folder/);
    expect(() => setProjectDir(join(dir, "missing"))).toThrow(/not a folder/);
    expect(projectDir()).toBeNull();
    setProjectDir(dir);
    expect(projectDir()).toBe(dir);
  });

  it("serves nothing without a project", async () => {
    setProjectDir(null);
    expect(await projectFile("demo.html")).toBeNull();
  });

  it("serves only the demo's own files", async () => {
    setProjectDir(dir);
    expect(await projectFile("secret.env")).toBeNull();
    expect(await projectFile("../package.json")).toBeNull();
    expect(await projectFile("demo.html")).toEqual({ body: "<h1>Hi</h1>", type: "text/html" });
    expect(await projectFile("demo.css")).toEqual({ body: "h1 { color: red }", type: "text/css" });
  });

  it("transpiles demo.ts to JavaScript", async () => {
    setProjectDir(dir);
    const js = await projectFile("demo.ts");
    expect(js?.type).toBe("text/javascript");
    expect(js?.body).not.toContain(": number");
    expect(js?.body).toMatch(/const x\s+= 1/); // Node blanks the types out in place
  });
});

// Checks on the Lumen page itself: they run only when PROJECT_DIR points at the Lumen folder.
const LUMEN = process.env.PROJECT_DIR;
describe.skipIf(!LUMEN)("Lumen page (PROJECT_DIR)", () => {
  const read = (rel: string): string => readFileSync(join(LUMEN!, rel), "utf8");
  const page = () => { const html = read("demo.html"); return { html, lines: html.split("\n") }; };

  it("every data-source points at the line it is on", () => {
    const { lines } = page();
    let count = 0;
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/data-source="([^"]*)"/g)) {
        count++;
        expect(m[1], `line ${i + 1}`).toBe(`demo.html:${i + 1}`);
      }
    });
    expect(count).toBeGreaterThan(30);
  });

  it("every element with data-source also has a data-label", () => {
    const { lines } = page();
    for (const [i, line] of lines.entries()) {
      const tags = line.match(/<[a-z][^>]*data-source=[^>]*>/g) ?? [];
      for (const tag of tags) expect(tag, `line ${i + 1}`).toMatch(/data-label="[^"]+"/);
    }
  });

  it("has the elements the benchmark utterances point at", () => {
    const { html } = page();
    for (const label of ["Site header", "Main navigation", "Get started button", "Feature card grid", "Signup form", "Pricing table"]) {
      expect(html).toContain(`data-label="${label}"`);
    }
  });

  it("DECISIONS.md cites the right lines", () => {
    const { lines } = page();
    const decisions = read("DECISIONS.md");
    const lineOf = (needle: string): number => lines.findIndex((l) => l.includes(needle)) + 1;
    expect(decisions).toContain(`demo.html:${lineOf('class="card-grid"')}`);
    expect(decisions).toContain(`demo.html:${lineOf('class="site-header"')}`);
    expect(decisions).toContain(`demo.html:${lineOf('class="cta"')}`);
  });
});
