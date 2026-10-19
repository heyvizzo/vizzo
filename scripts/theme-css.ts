// Writes the theme (shared/theme.ts) as a stylesheet for the Electron shell's pages (electron/shell/*.html link it).
// Run by `npm run build:electron`: tsx scripts/theme-css.ts dist-electron/shell/theme.css
import { writeFileSync } from "node:fs";
import { themeCss } from "../shared/theme.ts";

const out = process.argv[2];
if (!out) throw new Error("usage: tsx scripts/theme-css.ts <out.css>");
writeFileSync(out, `/* Generated from shared/theme.ts by scripts/theme-css.ts; edit that, not this. */\n${themeCss()}\n`);
