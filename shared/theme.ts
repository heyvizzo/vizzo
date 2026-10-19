/**
 * The app's colours, in one place for every surface: Chat, Settings, the Electron shell (toolbar, folder bar, gate,
 * divider, tooltip) and the overlay panels on the page. To rebrand, change BRAND; NEUTRALS is the blue-slate base and
 * STATUS the colours that mean something. accent-soft, accent-line, selected and focus-ring follow the accent.
 * LOGO is the app icon's two gradients (build/vizzo.icon): the blue field is the accent, the V's green is for the mark only
 * (green already means ok and done).
 *
 * Written out as CSS custom properties by themeCss(): Vite puts it in chat.html and settings.html (vite.config.ts),
 * the Electron build writes it to dist-electron/shell/theme.css (scripts/theme-css.ts), and the page overlay uses it
 * prefixed --ui-* (web/cursor/colors.ts). The thread-state palette is separate, in web/cursor/colors.ts.
 */
export type Mode = "light" | "dark";
type Tokens = Record<string, string>;

/** The app icon's gradients, top to bottom, with the colour each averages to. */
export const LOGO = {
  v: { from: "#01fcfb", mid: "#1cd29f", to: "#249861" },
  field: { from: "#7881ff", mid: "#3549c4", to: "#001993" },
} as const;

/** The logo's tokens, the same in both modes: the V's gradient and the field's, for the mark wherever it's drawn. */
const LOGO_TOKENS: Tokens = {
  "logo-v-from": LOGO.v.from, "logo-v-to": LOGO.v.to, "logo-field-from": LOGO.field.from, "logo-field-to": LOGO.field.to,
};

/**
 * The brand: `accent` for text, borders and rings; `accent-fill` behind `on-accent` text (the current item),
 * `accent-gradient` behind it on primary buttons (a gentler slice of the logo's field).
 */
export const BRAND = {
  light: {
    accent: LOGO.field.mid, "accent-fill": LOGO.field.mid, "accent-fill-hover": "#2236a8", "on-accent": "#ffffff",
    "accent-gradient": "linear-gradient(180deg, #4a57d6, #2a3bb0)", "accent-gradient-hover": "linear-gradient(180deg, #3f4cc9, #1f2f9e)",
    ...LOGO_TOKENS,
  },
  dark: {
    accent: LOGO.field.from, "accent-fill": LOGO.field.mid, "accent-fill-hover": "#2a3bb0", "on-accent": "#ffffff",
    "accent-gradient": "linear-gradient(180deg, #4a57d6, #2a3bb0)", "accent-gradient-hover": "linear-gradient(180deg, #5562e0, #3245bd)",
    ...LOGO_TOKENS,
  },
} satisfies Record<Mode, Tokens>;

/** Surfaces, lines and text. `chrome` is the app's frame (toolbar, folder bar, Settings' sidebar); `inverse` the tooltip. */
export const NEUTRALS = {
  light: {
    bg: "#f4f4f5", panel: "#ffffff", raised: "#fafafa", field: "#ffffff", sunken: "#f4f4f5", chrome: "#f4f4f5",
    line: "#d4d4d8", text: "#18181b", muted: "#71717a", placeholder: "#a1a1aa", code: "#3f3f46", hover: "#eef2f7",
    inverse: "#1f232c", "on-inverse": "#fafafa", "inverse-edge": "rgb(0 0 0 / 0.2)", shadow: "rgb(0 0 0 / 0.12)",
  },
  dark: {
    bg: "#0d1020", panel: "#151a2e", raised: "#1c2238", field: "#20273f", sunken: "#10142a", chrome: "#151a2e",
    line: "#29304a", text: "#e6e8f2", muted: "#8a92ad", placeholder: "#6a728d", code: "#cfd5ea", hover: "#1b2340",
    inverse: "#29304a", "on-inverse": "#fafafa", "inverse-edge": "rgb(255 255 255 / 0.12)", shadow: "rgb(0 0 0 / 0.35)",
  },
} satisfies Record<Mode, Tokens>;

/** Status and the hues Chat tags things with (intent badges, cursor rests, costs). */
export const STATUS = {
  light: {
    ok: "#16a34a", warn: "#b45309", err: "#dc2626", "err-text": "#b91c1c", "err-soft": "#fee2e2", cost: "#a16207",
    blue: "#1d4ed8", violet: "#6d28d9", indigo: "#4338ca", pink: "#db2777", "pink-soft": "#be185d",
  },
  dark: {
    ok: "#4ade80", warn: "#fbbf24", err: "#f87171", "err-text": "#fca5a5", "err-soft": "#7f1d1d", cost: "#e5c07b",
    blue: "#93c5fd", violet: "#c4b5fd", indigo: "#a5b4fc", pink: "#f472b6", "pink-soft": "#f9a8d4",
  },
} satisfies Record<Mode, Tokens>;

/** Every token's value, for code that needs a colour rather than a var() (canvas, Electron's window background). */
export const THEME = {
  light: { ...NEUTRALS.light, ...STATUS.light, ...BRAND.light },
  dark: { ...NEUTRALS.dark, ...STATUS.dark, ...BRAND.dark },
};

/** Tokens mixed from the accent, so they follow a rebrand (`v` names a token with the prefix). */
const derived = (v: (name: string) => string): Tokens => ({
  "accent-soft": `color-mix(in srgb, ${v("accent")} 8%, ${v("panel")})`,
  "accent-line": `color-mix(in srgb, ${v("accent")} 35%, ${v("panel")})`,
  selected: `color-mix(in srgb, ${v("accent")} 18%, ${v("panel")})`,
  "focus-ring": `color-mix(in srgb, ${v("accent")} 28%, transparent)`,
});

const decls = (tokens: Tokens, prefix: string) => Object.entries(tokens).map(([k, v]) => `--${prefix}${k}: ${v};`).join(" ");

/**
 * The theme as CSS: light on `scope`, dark when the system is dark. `prefix` namespaces the properties (the overlay's
 * --ui-*); `dataTheme` adds the [data-theme] overrides a page's root can force.
 */
export function themeCss({ scope = ":root", prefix = "", dataTheme = true }: { scope?: string; prefix?: string; dataTheme?: boolean } = {}): string {
  const mix = decls(derived((name) => `var(--${prefix}${name})`), prefix);
  const light = `${decls(THEME.light, prefix)} ${mix} color-scheme: light;`;
  const dark = `${decls(THEME.dark, prefix)} color-scheme: dark;`;
  if (!dataTheme) return `${scope} { ${light} }\n@media (prefers-color-scheme: dark) { ${scope} { ${dark} } }`;
  return `${scope} { ${light} }
@media (prefers-color-scheme: dark) { ${scope}:not([data-theme="light"]) { ${dark} } }
${scope}[data-theme="dark"] { ${dark} }`;
}

/** "#rrggbb" at `alpha`, as rgba() (canvas has no color-mix). */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
