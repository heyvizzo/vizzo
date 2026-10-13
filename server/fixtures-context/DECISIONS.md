# Lumen landing page: design decisions

Files: `web/cursor/demo/demo.html`, `demo.css`, `demo.ts`. Written by Maya (design) and Theo (front-end), March 2026.

## D1. Feature cards use CSS grid, not flexbox

**Where:** `.card-grid` in `demo.css`, markup at `demo.html:34`.

**Decision:** `display: grid` with `grid-template-columns: repeat(auto-fill, minmax(240px, 1fr))`, `grid-auto-rows: 1fr` and a 24px `gap`.

**Why:**
- **Two-dimensional alignment.** The cards have to line up in columns *and* rows. Flexbox lays out one axis at a time, so with `flex-wrap` every row sizes itself independently: card edges don't line up between rows and a short row stretches its cards wider than the ones above.
- **The orphan last row.** We have 5 cards (the Embeds card is double width). With `flex: 1 1 240px` the last row's cards grew to fill the whole width and looked like a different component. In grid they stay on the same column tracks.
- **Equal heights across rows.** `grid-auto-rows: 1fr` makes every row as tall as the tallest card, so the Alerts card (one line of copy) matches Live queries (two lines). Flexbox only equalizes height inside one row.
- **Responsive without media queries.** `auto-fill` + `minmax(240px, 1fr)` goes 4 → 3 → 2 → 1 columns as the viewport shrinks. The flexbox version needed three breakpoints to stop odd widths.
- **Spanning.** `.card--wide { grid-column: span 2 }` makes Embeds take two tracks. There's no clean equivalent in flexbox without hard-coding widths.

**Rejected:** flexbox with `flex-wrap` plus negative margins (pre-`gap` hack); a fixed 3-column grid (leaves a big empty area on wide screens).

**Trade-off:** `span 2` would overflow a 1-column layout, so there's one media query at 560px that resets it to `auto`.

## D2. Sticky header

**Where:** `.site-header` in `demo.css`, markup at `demo.html:11`, shadow logic in `demo.ts`.

**Decision:** `position: sticky; top: 0; z-index: 10` on the header, with a translucent background and `backdrop-filter: blur(8px)`.

**Why:**
- The page is long (hero, features, pricing, signup) and the nav is the main way to jump between sections. Usability testing (6 people) showed 4 of them scrolling back to the top to find "Pricing".
- **Sticky, not fixed.** `position: fixed` takes the header out of the flow, so the hero needed a hard-coded `padding-top` equal to the header height, which broke when the header wrapped on small screens. Sticky keeps its place in the flow and only pins once you scroll past it.
- `html { scroll-padding-top: calc(var(--header-h) + 16px) }` stops anchor jumps from hiding section headings under the header.
- The shadow appears only after scrolling (`.is-scrolled`, toggled in `demo.ts`) so the header looks flat on load.

**Gotcha:** sticky stops working if any ancestor has `overflow: hidden`. `<body>` and `<main>` must not set overflow.

## D3. Orange CTA color

**Where:** `.cta` in `demo.css` (`--cta: #e8590c`), button at `demo.html:27`.

**Decision:** the "Get started" button is orange `#e8590c` with white text, hover `#c94a06`. Everything else interactive uses the brand blue `#2f5bea`.

**Why:**
- **Isolation effect.** The page is blue, white and gray. A blue CTA blended in with the links and the logo. Orange is the complement of the brand blue, so it's the one warm spot on the page and the eye lands on it first.
- **A/B test.** Blue CTA vs orange CTA, 2 weeks, ~9k visitors per arm: orange got 11% more clicks on "Get started" (p ≈ 0.03).
- **Contrast.** White on `#e8590c` is 3.6:1. That passes WCAG AA for large text (the button text is 18px bold), not for body text. That's why the button copy is 18px/600 and must stay that size.
- The focus ring stays brand blue so keyboard focus is consistent across the page.

**Rejected:** green (read as "success/confirm" rather than "start"); red (read as destructive).
