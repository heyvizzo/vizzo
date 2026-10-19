import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { THEME, themeCss, withAlpha } from "./theme.ts";

const ROOT = join(import.meta.dirname, "..");
const HEX = /#[0-9a-f]{3,8}\b/gi;

describe("theme", () => {
  it("has the same tokens in light and dark", () => {
    expect(Object.keys(THEME.dark).sort()).toEqual(Object.keys(THEME.light).sort());
  });
  it("writes every token, prefixed, with the accent mixes on the same prefix", () => {
    const css = themeCss({ scope: ".x", prefix: "ui-", dataTheme: false });
    for (const name of Object.keys(THEME.light)) expect(css).toContain(`--ui-${name}:`);
    expect(css).toContain("--ui-accent-soft: color-mix(in srgb, var(--ui-accent) 8%, var(--ui-panel))");
    expect(css).not.toContain("data-theme");
  });
  it("lets a page force either mode", () => {
    const css = themeCss();
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).toContain(':root[data-theme="dark"]');
  });
  it("turns a hex into rgba", () => {
    expect(withAlpha("#818cf8", 0.4)).toBe("rgba(129, 140, 248, 0.4)");
  });
  // Colours belong in shared/theme.ts (or web/cursor/colors.ts), so a rebrand is one edit.
  it("leaves no hex colours in the stylesheets", () => {
    const sheets = ["web/public/style.css", "web/chat/chat.css", "web/settings/settings.css"].map((p) => [p, readFileSync(join(ROOT, p), "utf8")]);
    const shell = readdirSync(join(ROOT, "electron/shell")).filter((f) => f.endsWith(".html"))
      .map((f) => [`electron/shell/${f}`, /<style>([\s\S]*?)<\/style>/.exec(readFileSync(join(ROOT, "electron/shell", f), "utf8"))?.[1] ?? ""]);
    const found = [...sheets, ...shell].flatMap(([p, css]) => (css!.match(HEX) ?? []).map((hex) => `${p}: ${hex}`));
    expect(found).toEqual([]);
  });
});
