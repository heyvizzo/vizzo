// A text input with a suggestion list drawn in the page, in place of <input list> + <datalist>. In the
// Electron app the chat is a WebContentsView offset to the right of the browser pane, and Chromium places
// the datalist's native popup as if the view started at the window's left edge (it shows up over the
// browser). A list in the page's own DOM always opens under its input. Any text can still be typed.

/** The options to list for `typed`: all of them when it's empty or is exactly an option, else the ones containing it. */
export function comboMatches(options: readonly string[], typed: string): string[] {
  const q = typed.trim().toLowerCase();
  if (!q || options.some((o) => o.toLowerCase() === q)) return [...options];
  return options.filter((o) => o.toLowerCase().includes(q));
}

export interface Combo {
  setOptions(options: string[]): void;
}

/**
 * Wraps `input` with a ▾ button and a list under it. Picking an option sets the value and fires `change`
 * on the input, like typing it and leaving the field.
 */
export function attachCombo(input: HTMLInputElement): Combo {
  let options: string[] = [];
  let shown: string[] = [];
  let active = -1;

  const wrap = document.createElement("span");
  wrap.className = "combo";
  input.replaceWith(wrap);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "combo-toggle";
  toggle.tabIndex = -1;
  toggle.setAttribute("aria-label", "Show suggestions");
  toggle.title = "Show suggestions";
  toggle.textContent = "▾";
  const list = document.createElement("ul");
  list.className = "combo-list";
  list.id = `${input.id}-list`;
  list.setAttribute("role", "listbox");
  list.hidden = true;
  wrap.append(input, toggle, list);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("list");

  const isOpen = (): boolean => !list.hidden;
  const close = (): void => {
    list.hidden = true;
    active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const highlight = (i: number): void => {
    active = i;
    list.querySelectorAll("li").forEach((li, j) => li.classList.toggle("active", j === i));
    const li = list.children[i] as HTMLElement | undefined;
    if (li) { input.setAttribute("aria-activedescendant", li.id); li.scrollIntoView({ block: "nearest" }); }
  };
  const open = (all: boolean): void => {
    shown = all ? [...options] : comboMatches(options, input.value);
    if (!shown.length) return close();
    list.replaceChildren(...shown.map((o, i) => {
      const li = document.createElement("li");
      li.id = `${list.id}-${i}`;
      li.setAttribute("role", "option");
      li.textContent = o;
      if (o === input.value) li.classList.add("current");
      // mousedown, not click: picking must happen before the input's blur closes the list.
      li.onmousedown = (e) => { e.preventDefault(); pick(o); };
      return li;
    }));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    const cur = shown.indexOf(input.value);
    highlight(cur);
  };
  const pick = (o: string): void => {
    close();
    if (input.value === o) return;
    input.value = o;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  toggle.onmousedown = (e) => {
    e.preventDefault(); // keep the focus in the input
    if (isOpen()) return close();
    input.focus();
    open(true);
  };
  input.addEventListener("input", () => open(false));
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen()) return open(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      highlight((active + step + shown.length) % shown.length);
    } else if (e.key === "Enter" && isOpen() && active >= 0) {
      e.preventDefault();
      pick(shown[active]!);
    } else if (e.key === "Escape" && isOpen()) {
      e.preventDefault();
      close();
    }
  });

  return {
    setOptions(next) {
      options = next;
      if (isOpen()) open(false);
    },
  };
}
