// Settings → Speech to text: the language picker next to each model (what it offers depends on the model:
// shared/config.ts STT_LANGUAGE_SUPPORT) and the pointing-word lists under the models (one textarea per language,
// switched with tabs; shared/languages.ts has the starting lists).
import { STT_LANGUAGE_SUPPORT, sttLanguageOptions, type SttModel } from "../../shared/config.ts";
import { DEFAULT_POINTING_WORDS, LANGUAGE_CODES, languageLabel, languageName, parsePointingWords } from "../../shared/languages.ts";
import { sttLanguages, type Settings } from "../chat/settings.ts";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const option = (value: string, label: string): HTMLOptionElement => {
  const o = el("option", undefined, label);
  o.value = value;
  return o;
};

export interface LanguagePicker {
  el: HTMLElement;
  /** Show the saved selection. */
  fill(): void;
}

/** The language select's value for "Languages I speak": auto-detect among them. */
const AMONG = "*";

/**
 * A model's language control. A model that says which language it heard: Auto or one language, and (one that can
 * limit its detection) Auto among the languages you speak. One that doesn't: the languages you speak, one or more
 * (chips, and a list to add from). One that needs to be told: one language.
 */
export function languagePicker(model: SttModel, settings: Settings, changed: () => void): LanguagePicker {
  const { mode, limit } = STT_LANGUAGE_SUPPORT[model];
  const offered = sttLanguageOptions(model);
  const current = (): string[] => sttLanguages(settings, model);
  const set = (languages: string[]): void => {
    settings.sttLanguages = { ...settings.sttLanguages, [model]: languages };
    changed();
  };
  const wrap = el("div", "param wide lang-param");
  wrap.append(el("span", "param-label", mode === "multi" ? "Languages you speak" : "Language"));

  // The languages you speak: chips to remove (keeping `keep`), and a list to add from.
  const chips = el("div", "lang-chips");
  const add = el("select");
  add.setAttribute("aria-label", "Add a language");
  add.title = mode === "multi"
    ? "This model doesn't say which language it heard, so choose the ones you speak: their pointing words are used together."
    : "The model detects which of these you spoke.";
  add.onchange = () => { if (add.value) set([...current(), add.value]); };
  const fillChips = (chosen: string[], keep: number): void => {
    chips.replaceChildren(...chosen.map((c) => {
      const chip = el("button", "lang-chip", languageName(c));
      chip.type = "button";
      chip.disabled = chosen.length <= keep;
      chip.title = chip.disabled ? `Add another language before removing this one` : `Remove ${languageName(c)}`;
      chip.setAttribute("aria-label", chip.disabled ? languageName(c) : `Remove ${languageName(c)}`);
      if (!chip.disabled) chip.append(el("span", "lang-chip-x", "×"));
      chip.onclick = () => set(current().filter((x) => x !== c));
      return chip;
    }));
    const rest = offered.filter((c) => !chosen.includes(c));
    add.replaceChildren(option("", "Add a language…"), ...rest.map((c) => option(c, languageLabel(c))));
    add.value = "";
    add.hidden = rest.length === 0;
  };

  if (mode === "multi") {
    wrap.append(chips, add);
    return { el: wrap, fill: () => fillChips(current(), 1) };
  }

  const select = el("select");
  select.setAttribute("aria-label", "Language");
  if (mode === "auto") select.append(option("", "Auto-detect"));
  if (limit) select.append(option(AMONG, "Languages I speak"));
  select.append(...offered.map((c) => option(c, languageLabel(c))));
  select.disabled = mode === "single" && offered.length < 2;
  const rumble = model === "local_rumble-2-flash" ? "Auto-detect the spoken language or choose one to guide transcription." : undefined;
  const titles: Record<string, string> = {
    "": rumble ?? "Auto-detect: the model says which language it heard, and that language's pointing words are used.",
    [AMONG]: "Auto-detect, but only among the languages you speak, so a short clip isn't heard as another language.",
  };
  const pinTitle = rumble ?? (mode === "auto" ? "Transcribe in this language only." : "This model has to be told the language.");
  // Chose "from languages I speak" with only one at hand: stays until a second one is added (or another choice).
  let among = false;
  select.onchange = () => {
    among = select.value === AMONG;
    if (!among) return set(select.value ? [select.value] : []);
    const others = Object.values(settings.sttLanguages).flat();
    const seed = [...new Set([...current(), ...others, "en"])].filter((c) => offered.includes(c)).slice(0, 2);
    set(seed);
  };
  wrap.append(select);
  if (limit) wrap.append(chips, add);
  const fill = (): void => {
    const chosen = current();
    if (chosen.length > 1) among = true;
    const value = among ? AMONG : chosen[0] ?? "";
    if (document.activeElement !== select) select.value = value;
    select.title = titles[value] ?? pinTitle;
    chips.hidden = add.hidden = !among;
    if (among) fillChips(chosen, 2);
  };
  return { el: wrap, fill };
}

/** Whether a list is the language's starting one (same entries, in any order). */
export function isDefaultList(code: string, entries: readonly string[]): boolean {
  const base = DEFAULT_POINTING_WORDS[code] ?? [];
  return entries.length === base.length && entries.every((w) => base.includes(w));
}

/**
 * The languages that get a tab: the selected model's, then the ones chosen for other models, then any whose list was
 * edited or opened here; English when there would be none (Auto).
 */
export function pointingTabs(settings: Settings, opened: readonly string[] = []): string[] {
  const all = [...new Set([...pickedLanguages(settings), ...Object.keys(settings.pointingWords), ...opened])];
  return all.length ? all : ["en"];
}

/** The languages chosen for the models (the selected one's, then the others'): their tabs stay. */
function pickedLanguages(settings: Settings): string[] {
  const models = Object.keys(STT_LANGUAGE_SUPPORT) as SttModel[];
  return [settings.sttModel, ...models].flatMap((m) => (m === settings.sttModel || settings.sttLanguages[m] ? sttLanguages(settings, m) : []));
}

/** Whether a tab can be closed: it was opened here or its list edited, and no model uses the language. */
export function closableTab(settings: Settings, code: string, opened: readonly string[] = []): boolean {
  return (opened.includes(code) || code in settings.pointingWords) && !pickedLanguages(settings).includes(code);
}

/** The pointing-word lists: a tab per language in use, its list in a textarea, Reset once it was edited. */
export function mountPointingWords(box: HTMLElement, settings: Settings, save: () => void): { render(): void } {
  const opened: string[] = [];
  let active = "";
  const tabs = el("div", "lang-tabs");
  tabs.setAttribute("role", "tablist");
  const other = el("select", "lang-other");
  other.setAttribute("aria-label", "Open another language's list");
  const area = el("textarea", "lang-words");
  area.rows = 4;
  area.spellcheck = false;
  area.setAttribute("aria-label", "Pointing words");
  const foot = el("div", "lang-foot");
  const hint = el("p", "hint");
  const reset = el("button", "small", "Reset to default");
  reset.type = "button";
  foot.append(hint, reset);
  const head = el("div", "lang-head");
  head.append(tabs, other);
  box.append(head, area, foot);

  const textOf = (code: string): string => settings.pointingWords[code] ?? (DEFAULT_POINTING_WORDS[code] ?? []).join(", ");

  function render(): void {
    const codes = pointingTabs(settings, opened);
    if (!codes.includes(active)) active = codes[0]!;
    tabs.replaceChildren(...codes.map((c) => {
      const wrap = el("span", "lang-tab-wrap");
      const tab = el("button", "lang-tab", languageName(c));
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(c === active));
      if (c in settings.pointingWords) tab.append(el("span", "lang-edited", " (edited)"));
      tab.onclick = () => { active = c; render(); };
      wrap.append(tab);
      if (closableTab(settings, c, opened)) {
        const close = el("button", "lang-tab-close", "×");
        close.type = "button";
        const what = c in settings.pointingWords ? `Close ${languageName(c)} and discard its edited list` : `Close ${languageName(c)}`;
        close.title = what;
        close.setAttribute("aria-label", what);
        close.onclick = () => closeTab(c);
        wrap.append(close);
      }
      return wrap;
    }));
    const rest = LANGUAGE_CODES.filter((c) => !codes.includes(c));
    other.replaceChildren(option("", "Other language…"), ...rest.map((c) => option(c, languageLabel(c))));
    other.value = "";
    other.hidden = rest.length === 0;
    if (document.activeElement !== area) area.value = textOf(active);
    area.lang = active;
    const edited = active in settings.pointingWords;
    reset.hidden = !edited;
    const count = parsePointingWords(area.value).length;
    hint.textContent = `${languageName(active)}: ${count} word${count === 1 ? "" : "s"}${edited ? ", edited" : ""}. Separate them with commas or spaces. Case and punctuation are ignored, accents are not; end an entry with * to match every word that starts with it.`;
  }

  // Closing drops the tab; an edited list goes with it (otherwise the tab would come back with it).
  function closeTab(code: string): void {
    const at = opened.indexOf(code);
    if (at >= 0) opened.splice(at, 1);
    if (code in settings.pointingWords) {
      const next = { ...settings.pointingWords };
      delete next[code];
      settings.pointingWords = next;
      save();
    }
    if (code === active) { active = ""; area.blur(); }
    render();
  }

  other.onchange = () => {
    if (!other.value) return;
    opened.push(other.value);
    active = other.value;
    render();
  };
  area.oninput = () => {
    const entries = parsePointingWords(area.value);
    const next = { ...settings.pointingWords };
    if (isDefaultList(active, entries)) delete next[active]; else next[active] = area.value;
    settings.pointingWords = next;
    save();
    render();
  };
  reset.onclick = () => {
    const next = { ...settings.pointingWords };
    delete next[active];
    settings.pointingWords = next;
    save();
    area.value = textOf(active);
    render();
  };
  render();
  return { render };
}
