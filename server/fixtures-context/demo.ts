// Lumen marketing page behavior (cursor-lab demo). Decisions D1–D3 live in DECISIONS.md.

const header = document.querySelector<HTMLElement>(".site-header");
const navLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>(".main-nav a"));

// D2: the header is `position: sticky` in CSS; JS only adds a shadow once the page has scrolled.
function onScroll(): void {
  header?.classList.toggle("is-scrolled", window.scrollY > 4);
}
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

// Highlight the nav link for the section currently under the header.
const sections = navLinks
  .map((a) => document.querySelector<HTMLElement>(a.hash))
  .filter((s): s is HTMLElement => s !== null);

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const a of navLinks) a.setAttribute("aria-current", String(a.hash === `#${entry.target.id}`));
    }
  },
  { rootMargin: "-64px 0px -60% 0px" },
);
sections.forEach((s) => observer.observe(s));

// D3: the CTA scrolls to the signup form and focuses the email field.
document.querySelector<HTMLButtonElement>(".cta")?.addEventListener("click", () => {
  document.getElementById("signup")?.scrollIntoView({ behavior: "smooth" });
  document.getElementById("email")?.focus({ preventScroll: true });
});

// Signup form: client-side check only; the demo has no backend.
const form = document.querySelector<HTMLFormElement>(".signup-form");
const errorEl = document.querySelector<HTMLParagraphElement>(".form-error");

export function validateEmail(value: string): string | null {
  if (!value.trim()) return "Enter your work email.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "That doesn't look like an email address.";
  return null;
}

form?.addEventListener("submit", (e) => {
  e.preventDefault();
  const email = (form.elements.namedItem("email") as HTMLInputElement | null)?.value ?? "";
  const error = validateEmail(email);
  if (errorEl) {
    errorEl.hidden = error === null;
    errorEl.textContent = error ?? "";
  }
  if (!error) form.reset();
});
