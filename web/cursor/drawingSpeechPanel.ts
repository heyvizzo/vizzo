import { drawingStrokeColor, type DrawingStroke } from "../../shared/annotations.ts";

export interface DrawingSpeechPanelEntry {
  id: string;
  noteId: string;
  noteNumber: number;
  text: string;
  start: number;
  end: number;
  source: "automatic" | "selected" | "manual" | "unlinked";
  strokeIds: string[];
}
export interface DrawingSpeechPanelOptions {
  entries(): readonly DrawingSpeechPanelEntry[];
  strokes(): readonly DrawingStroke[];
  selection(): readonly string[];
  setLinks(phraseId: string, ids: string[]): void;
  selectMarks(ids: string[]): void;
  focusText(start: number, end: number): void;
}

export const DRAWING_SPEECH_PANEL_CSS = `
.draw-speech { margin-top:8px; border-top:1px solid var(--ui-line); padding-top:7px; }
.draw-speech[hidden] { display:none; }
.draw-speech-heading { margin:0 0 5px; font-size:11px; font-weight:600; color:var(--ui-muted); }
.draw-speech-list { max-height:160px; overflow:auto; overscroll-behavior:contain; scrollbar-width:thin; }
.draw-speech-row { padding:5px 2px; border-bottom:1px solid var(--ui-line); }
.draw-speech-row:last-child { border-bottom:0; }
.draw-speech-line,.draw-speech-links,.draw-speech-choices,.draw-speech-actions { display:flex; align-items:center; gap:5px; flex-wrap:wrap; }
.draw-speech button { font:inherit; font-size:11px; color:var(--ui-text); background:var(--ui-field,var(--ui-sunken)); border:1px solid var(--ui-line); border-radius:6px; padding:3px 6px; cursor:pointer; }
.draw-speech button:hover:not(:disabled) { background:var(--ui-hover); border-color:var(--ui-accent); }
.draw-speech button:focus-visible { outline:2px solid var(--ui-accent); outline-offset:2px; }
.draw-speech button:disabled { opacity:.4; cursor:default; }
.draw-speech .draw-speech-phrase { flex:1; min-width:100px; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:left; background:transparent; border-color:transparent; font-size:12px; }
.draw-speech-source,.draw-speech-empty { font-size:10px; color:var(--ui-muted); }
.draw-speech-links { margin-top:3px; }
.draw-speech .draw-speech-mark { display:inline-flex; align-items:center; gap:4px; }
.draw-speech-dot { width:8px; height:8px; border-radius:50%; background:var(--mark-color); box-shadow:0 0 0 1px var(--ui-line); }
.draw-speech-mark[aria-pressed=true] { border-color:var(--ui-accent); background:var(--ui-focus-ring,var(--ui-hover)); }
.draw-speech-editor { padding:6px; margin-top:5px; border:1px solid var(--ui-line); border-radius:7px; background:var(--ui-sunken); }
.draw-speech-editor[hidden] { display:none; }
.draw-speech-actions { margin-top:6px; }
`;

const sourceLabels = { automatic: "Suggested", selected: "Selected", manual: "Edited", unlinked: "Unlinked" } as const;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
}
function button(cls: string, text: string): HTMLButtonElement {
  const node = element("button", cls);
  node.type = "button";
  node.textContent = text;
  return node;
}
interface Row {
  entry: DrawingSpeechPanelEntry;
  root: HTMLDivElement;
  phrase: HTMLButtonElement;
  source: HTMLSpanElement;
  links: HTMLDivElement;
  chips: Map<string, HTMLButtonElement>;
  empty: HTMLSpanElement;
  edit: HTMLButtonElement;
  editor: HTMLDivElement;
  choices: HTMLDivElement;
  toggles: Map<string, HTMLButtonElement>;
  use: HTMLButtonElement;
  clear: HTMLButtonElement;
}

/** Stable keyed controls preserve focus while links/selection change; geometry changes do not rebuild the panel. */
export function createDrawingSpeechPanel(opts: DrawingSpeechPanelOptions): { root: HTMLDivElement; render(): void; destroy(): void } {
  const root = element("div", "draw-speech");
  root.dataset.drawingSpeechPanel = "";
  const heading = element("h3", "draw-speech-heading");
  heading.textContent = "Voice links";
  const list = element("div", "draw-speech-list");
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", "Spoken phrases and their linked marks");
  root.append(heading, list);
  const rows = new Map<string, Row>();
  let expanded: string | null = null;
  let signature = "";
  let destroyed = false;

  function createRow(entry: DrawingSpeechPanelEntry): Row {
    const row: Row = {
      entry, root: element("div", "draw-speech-row"), phrase: button("draw-speech-phrase", ""),
      source: element("span", "draw-speech-source"), links: element("div", "draw-speech-links"),
      chips: new Map(), empty: element("span", "draw-speech-empty"), edit: button("draw-speech-edit", "Edit links"),
      editor: element("div", "draw-speech-editor"), choices: element("div", "draw-speech-choices"),
      toggles: new Map(), use: button("", "Use selection"), clear: button("", "Clear"),
    };
    row.root.dataset.phraseId = entry.id;
    row.root.setAttribute("role", "listitem");
    row.empty.textContent = "No linked marks";
    row.phrase.onclick = () => opts.focusText(row.entry.start, row.entry.end);
    row.edit.onclick = () => { expanded = expanded === row.entry.id ? null : row.entry.id; signature = ""; render(); };
    row.use.onclick = () => {
      const current = new Set(opts.strokes().map(s => s.id));
      opts.setLinks(row.entry.id, [...opts.selection()].filter(id => current.has(id)));
      render();
    };
    row.clear.onclick = () => { opts.setLinks(row.entry.id, []); render(); };
    const line = element("div", "draw-speech-line");
    line.append(row.phrase, row.source, row.edit);
    const actions = element("div", "draw-speech-actions");
    actions.append(row.use, row.clear);
    row.editor.append(row.choices, actions);
    row.root.append(line, row.links, row.editor);
    return row;
  }

  function markButton(stroke: DrawingStroke, number: number, choose: boolean): HTMLButtonElement {
    const chip = button("draw-speech-mark", "");
    chip.dataset.strokeId = stroke.id;
    const dot = element("span", "draw-speech-dot");
    dot.setAttribute("aria-hidden", "true");
    const label = element("span", "draw-speech-mark-number");
    chip.append(dot, label);
    chip.setAttribute("aria-label", `${choose ? "Toggle link to" : "Select"} mark ${number}`);
    return chip;
  }

  function syncChips(row: Row, strokes: readonly DrawingStroke[], selection: Set<string>, chooser: boolean): void {
    const parent = chooser ? row.choices : row.links;
    const cache = chooser ? row.toggles : row.chips;
    const visible = chooser ? strokes : strokes.filter(s => row.entry.strokeIds.includes(s.id));
    const keep = new Set(visible.map(s => s.id));
    for (const [id, chip] of cache) if (!keep.has(id)) { chip.remove(); cache.delete(id); }
    visible.forEach((stroke, i) => {
      const number = stroke.label ?? strokes.indexOf(stroke) + 1;
      let chip = cache.get(stroke.id);
      if (!chip) {
        chip = markButton(stroke, number, chooser);
        if (chooser) chip.onclick = () => {
          // Preserve hidden/deleted references until an explicit replacement or Clear, so undo can restore them.
          const ids = new Set(row.entry.strokeIds);
          if (ids.has(stroke.id)) ids.delete(stroke.id); else ids.add(stroke.id);
          opts.setLinks(row.entry.id, [...ids]);
          render();
        };
        else chip.onclick = () => { opts.selectMarks([stroke.id]); render(); };
        cache.set(stroke.id, chip);
      }
      chip.style.setProperty("--mark-color", drawingStrokeColor(stroke));
      chip.querySelector(".draw-speech-mark-number")!.textContent = String(number);
      chip.setAttribute("aria-label", `${chooser ? "Toggle link to" : "Select"} mark ${number}`);
      chip.setAttribute("aria-pressed", String(chooser ? row.entry.strokeIds.includes(stroke.id) : selection.has(stroke.id)));
      // Avoid moving focused nodes during ordinary updates.
      if (parent.children[i] !== chip) parent.insertBefore(chip, parent.children[i] ?? null);
    });
    if (!chooser) {
      row.empty.hidden = visible.length > 0;
      if (!row.empty.parentNode) parent.append(row.empty);
    }
  }

  function render(): void {
    if (destroyed) return;
    const entries = opts.entries();
    const strokes = opts.strokes();
    const selected = opts.selection();
    const next = JSON.stringify([entries, strokes.map(s => [s.id, s.label, drawingStrokeColor(s)]), selected, expanded]);
    if (next === signature) return;
    signature = next;
    root.hidden = entries.length === 0;
    const keep = new Set(entries.map(e => e.id));
    for (const [id, row] of rows) if (!keep.has(id)) { row.root.remove(); rows.delete(id); }
    if (expanded && !keep.has(expanded)) expanded = null;
    const selection = new Set(selected);
    const currentIds = new Set(strokes.map(s => s.id));
    entries.forEach((entry, i) => {
      let row = rows.get(entry.id);
      if (!row) { row = createRow(entry); rows.set(entry.id, row); }
      row.entry = entry;
      row.phrase.textContent = entry.text;
      row.phrase.title = entry.text;
      row.phrase.setAttribute("aria-label", `Edit spoken phrase from voice note ${entry.noteNumber}: ${entry.text}`);
      const visibleSource = entry.strokeIds.some(id => currentIds.has(id)) ? entry.source : 'unlinked';
      row.source.textContent = `Note ${entry.noteNumber} · ${sourceLabels[visibleSource]}`;
      row.edit.setAttribute("aria-expanded", String(expanded === entry.id));
      row.edit.setAttribute("aria-label", `Edit mark links for phrase: ${entry.text}`);
      row.editor.hidden = expanded !== entry.id;
      row.use.disabled = !selected.some(id => currentIds.has(id));
      row.clear.disabled = entry.strokeIds.length === 0;
      syncChips(row, strokes, selection, false);
      if (!row.editor.hidden) syncChips(row, strokes, selection, true);
      if (list.children[i] !== row.root) list.insertBefore(row.root, list.children[i] ?? null);
    });
  }
  render();
  return { root, render, destroy() { destroyed = true; rows.clear(); root.remove(); } };
}
