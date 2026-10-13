// Minimal built-in demo page, used only when web/cursor/demo/demo.html (T6) isn't in the build.
// data-source points at this file's lines so picks are still traceable.
const SRC = "web/cursor/fallbackDemo.ts";

export const FALLBACK_DEMO_CSS = `
:root { --fd-accent: #2563eb; color: #111; background: #f7f7f8; font-family: system-ui, sans-serif; }
header { position: sticky; top: 0; display: flex; gap: 16px; align-items: center; padding: 12px 20px; background: #fff; border-bottom: 1px solid #ddd; z-index: 2; }
header nav a { color: #333; text-decoration: none; margin-right: 12px; }
.hero { padding: 48px 20px; text-align: center; }
.hero button { background: var(--fd-accent); color: #fff; border: 0; border-radius: 8px; padding: 12px 22px; font-size: 16px; }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; padding: 20px; }
.card { background: #fff; border: 1px solid #ddd; border-radius: 10px; padding: 16px; min-height: 120px; }
form { display: grid; gap: 8px; max-width: 360px; padding: 20px; }
form input, form button { padding: 8px; color: #111; background: #fff; border: 1px solid #bbb; border-radius: 6px; }
table { margin: 20px; border-collapse: collapse; background: #fff; }
td, th { border: 1px solid #ddd; padding: 8px 14px; }
footer { padding: 400px 20px 40px; color: #666; }
`;

export const FALLBACK_DEMO_HTML = `
<header data-source="${SRC}:20" data-label="Sticky header">
  <strong data-source="${SRC}:21" data-label="Logo">Acme</strong>
  <nav data-source="${SRC}:22" data-label="Main nav">
    <a href="#" data-source="${SRC}:23" data-label="Nav: Pricing">Pricing</a>
    <a href="#" data-source="${SRC}:24" data-label="Nav: Docs">Docs</a>
  </nav>
</header>
<section class="hero" data-source="${SRC}:27" data-label="Hero">
  <h1 data-source="${SRC}:28" data-label="Hero title">Ship faster</h1>
  <button type="button" data-source="${SRC}:29" data-label="Get started">Get started</button>
</section>
<section class="cards" data-source="${SRC}:31" data-label="Card grid">
  <article class="card" data-source="${SRC}:32" data-label="Card: Speed"><h3>Speed</h3><p>Fast builds.</p></article>
  <article class="card" data-source="${SRC}:33" data-label="Card: Safety"><h3>Safety</h3><p>Typed APIs.</p></article>
  <article class="card" data-source="${SRC}:34" data-label="Card: Scale"><h3>Scale</h3><p>Grows with you.</p></article>
</section>
<form data-source="${SRC}:36" data-label="Signup form" onsubmit="return false">
  <input placeholder="Email" data-source="${SRC}:37" data-label="Email field" />
  <button type="submit" data-source="${SRC}:38" data-label="Subscribe">Subscribe</button>
</form>
<table data-source="${SRC}:40" data-label="Plans table">
  <tr><th>Plan</th><th>Price</th></tr>
  <tr data-source="${SRC}:42" data-label="Row: Free"><td>Free</td><td>$0</td></tr>
  <tr data-source="${SRC}:43" data-label="Row: Pro"><td>Pro</td><td>$12</td></tr>
</table>
<footer data-source="${SRC}:45" data-label="Footer">Scroll area · fallback demo (T6's demo page not built yet)</footer>
`;
