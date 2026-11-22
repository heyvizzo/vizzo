import { changedFileCount, groupComponents, type ChangeComponent, type ChangeDiff, type ChangeFile, type ChangeGroup, type ChangeHunk, type ChangeWriter } from "../../shared/changes.ts";
import { changesApi, ChangesError } from "./api.ts";
import type { ChangesReview } from "./review.ts";

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const writerKey = ({ kind, id }: ChangeWriter): string => JSON.stringify([kind, id]);
const filesLabel = (count: number): string => `${count} ${count === 1 ? "file" : "files"}`;
const writerLabels = { thread: "Thread", central: "Conversation", job: "Background job" };
const entryLabels = { text: "", binary: "Binary", symlink: "Symlink", move: "Move", presence: "File entry", mode: "Mode", unavailable: "Unavailable" };
const hunkLabels = { content: "Content", presence: "File entry", type: "Type", mode: "Mode", opaque: "Whole entry" };
const groupStates = { open: "", working: "Still working…", stopping: "Stopping…", closed: "Closed" };

function diffLines(text: string, sign: string, markEnding: boolean): string {
  const hasEnding = text.endsWith("\n");
  const lines = hasEnding ? text.slice(0, -1) : text;
  const prefix = `${sign} `;
  return prefix + lines.replaceAll("\n", `\n${prefix}`) + (markEnding && !hasEnding ? "\n\\ No newline at end of file" : "");
}

function hunkNode(hunk: ChangeHunk, writers: ReadonlyMap<string, string>): HTMLElement {
  const hunkView = element("div", "hunk");
  const labels = hunk.writers.map(writer => writers.get(writerKey(writer)) ?? writerLabels[writer.kind]);
  if (hunk.other) labels.push("Other");
  const range = hunk.range;
  const heading = range
    ? `@@ -${range.oldStart + Number(range.oldCount > 0)},${range.oldCount} +${range.newStart + Number(range.newCount > 0)},${range.newCount} @@`
    : hunkLabels[hunk.kind];
  const header = element("div", "hunk-head");
  header.append(element("code", "hunk-range", heading), element("span", undefined, labels.join(", ")));
  hunkView.append(header);
  if (hunk.reason) hunkView.append(element("p", "hunk-note hint", hunk.reason));
  if (hunk.before) hunkView.append(element("pre", "removed", diffLines(hunk.before, "−", !!range)));
  if (hunk.after) hunkView.append(element("pre", "added", diffLines(hunk.after, "+", !!range)));
  return hunkView;
}

export class ChangesList {
  private openFiles = new Set<string>();
  private othersOpen = false;
  private snapshot = "";
  private reasons = 0;
  private diffs = new Map<string, Promise<ChangeDiff>>();
  private writerNames = new Map<string, string>();
  private cardTicks = new Map<HTMLInputElement, readonly string[]>();

  constructor(
    private readonly root: HTMLElement,
    private readonly review: ChangesReview,
    private readonly selectionChanged: () => void,
    private readonly stale: (error: ChangesError) => void,
  ) {}

  resetDisclosures(): void {
    this.openFiles.clear();
    this.othersOpen = false;
  }

  render(): void {
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset.focusKey;
    const { project, view, scope, scopedGroup, components } = this.review;
    this.root.replaceChildren();
    this.cardTicks.clear();
    this.reasons = 0;
    const snapshot = JSON.stringify([project, view?.generation]);
    if (snapshot !== this.snapshot) {
      this.snapshot = snapshot;
      this.diffs.clear();
    }
    if (!view) return;

    const openFiles = this.openFiles;
    this.openFiles = new Set();
    this.writerNames = new Map(view.groups.map(group => [writerKey(group.writer), group.title]));
    if (scopedGroup) this.root.append(this.group(scopedGroup, openFiles));
    const remaining = view.groups.filter(group => group !== scopedGroup);
    if (scope !== null && remaining.length) {
      const collapsed = element("details", "other-threads");
      const summary = element("summary", undefined, `Other threads (${remaining.length})`);
      summary.dataset.focusKey = "other-threads";
      collapsed.open = this.othersOpen;
      collapsed.addEventListener("toggle", () => { if (collapsed.isConnected) this.othersOpen = collapsed.open; });
      collapsed.append(summary, ...remaining.map(group => this.group(group, openFiles)));
      this.root.append(collapsed);
    } else {
      this.root.append(...remaining.map(group => this.group(group, openFiles)));
    }

    const other = [...components.values()].filter(component => component.other && !component.writers.length);
    if (other.length) {
      const card = this.card("Other changes", other);
      for (const component of other) card.append(this.component(component, null, "Other changes", openFiles));
      this.root.append(card);
    }
    if (focusKey) {
      const target = [...this.root.querySelectorAll<HTMLElement>("[data-focus-key]")].find(node => node.dataset.focusKey === focusKey);
      target?.focus({ preventScroll: true });
    }
  }

  syncSelection(busy: boolean): void {
    for (const tick of this.root.querySelectorAll<HTMLInputElement>("input[data-component]")) {
      const id = tick.dataset.component!;
      tick.checked = this.review.selected.has(id);
      tick.disabled = busy || !this.review.components.get(id)?.selectable;
    }
    for (const [tick, ids] of this.cardTicks) this.syncCardTick(tick, ids, busy);
  }

  private syncCardTick(tick: HTMLInputElement, ids: readonly string[], busy = false): void {
    const state = this.review.selectManyState(ids);
    tick.checked = state.checked;
    tick.indeterminate = state.indeterminate;
    tick.disabled = busy || !state.available;
  }

  private card(title: string, components: readonly ChangeComponent[], state?: string, key = title): HTMLElement {
    const card = element("section", "card");
    const header = element("header", "group-head");
    const count = changedFileCount(components);
    const ids = components.map(component => component.id);
    const tick = element("input");
    tick.type = "checkbox";
    tick.dataset.focusKey = JSON.stringify(["card", key]);
    tick.setAttribute("aria-label", `Select all files in ${title}`);
    this.syncCardTick(tick, ids);
    tick.addEventListener("change", () => {
      this.review.toggleMany(ids, tick.checked);
      this.selectionChanged();
    });
    this.cardTicks.set(tick, ids);
    header.append(tick, element("h2", undefined, title), element("span", "hint", filesLabel(count)));
    if (state) header.append(element("p", "hint group-state", state));
    card.append(header);
    return card;
  }

  private group(group: ChangeGroup, openFiles: ReadonlySet<string>): HTMLElement {
    const components = groupComponents(group, this.review.components);
    const state = [group.reason || groupStates[group.state], group.incomplete ? "Incomplete work" : ""].filter(Boolean).join(" · ");
    const card = this.card(group.title, components, state, writerKey(group.writer));
    card.setAttribute("aria-label", `${writerLabels[group.writer.kind]}: ${group.title}`);
    for (const component of components) card.append(this.component(component, group, group.title, openFiles));
    return card;
  }

  private component(component: ChangeComponent, group: ChangeGroup | null, title: string, openFiles: ReadonlySet<string>): HTMLElement {
    const row = element("div", "component");
    const owner = group ? writerKey(group.writer) : "Other";
    const tick = element("input");
    tick.type = "checkbox";
    tick.dataset.component = component.id;
    tick.dataset.focusKey = JSON.stringify([owner, component.id]);
    tick.checked = this.review.selected.has(component.id);
    tick.disabled = !component.selectable;
    tick.setAttribute("aria-label", `Select ${component.files.map(file => file.path).join(", ")} in ${title}`);
    tick.addEventListener("change", () => {
      this.review.toggle(component.id, tick.checked);
      this.selectionChanged();
    });

    const body = element("div", "component-body");
    for (const file of component.files) body.append(this.file(component.id, file, owner, openFiles));
    const reasons = [component.tieReason, component.other ? "Needs your call" : undefined,
      component.incomplete && !group?.incomplete ? "Incomplete work" : undefined,
      component.reason, component.requires?.length ? "Requires selecting the file’s creation too" : undefined].filter(Boolean);
    if (reasons.length) {
      const note = element("p", "hint component-note", reasons.join(" · "));
      note.id = `component-reason-${++this.reasons}`;
      tick.setAttribute("aria-describedby", note.id);
      body.append(note);
    }
    row.append(tick, body);
    return row;
  }

  private file(component: string, file: ChangeFile, owner: string, openFiles: ReadonlySet<string>): HTMLElement {
    const { project, view } = this.review;
    const key = JSON.stringify([owner, component, file.path]);
    const disclosure = element("details", "file");
    const summary = element("summary", "file-summary");
    summary.dataset.focusKey = key;
    const path = element("span", "file-path", file.path);
    path.title = file.path;
    summary.append(path);
    const kind = entryLabels[file.entry];
    if (kind) summary.append(element("span", "hint file-kind", kind));
    const counts = element("span", "file-counts");
    counts.append(element("span", "added", `+${file.added}`), element("span", "removed", `−${file.removed}`));
    summary.append(counts);

    const content = element("div", "diff");
    disclosure.append(summary, content);
    disclosure.open = openFiles.has(key);
    if (disclosure.open) this.openFiles.add(key);
    disclosure.addEventListener("toggle", () => {
      if (!disclosure.isConnected) return;
      if (!disclosure.open) {
        this.openFiles.delete(key);
        return;
      }
      this.openFiles.add(key);
      if (content.dataset.loaded || project === undefined || !view) return;
      content.dataset.loaded = "true";
      content.textContent = "Loading diff…";
      const diffKey = JSON.stringify([component, file.path]);
      let pending = this.diffs.get(diffKey);
      if (!pending) {
        pending = changesApi.diff(project, view.generation, component, file.path);
        this.diffs.set(diffKey, pending);
      }
      void pending.then(diff => {
        if (content.isConnected) content.replaceChildren(...diff.hunks.map(hunk => hunkNode(hunk, this.writerNames)));
      }).catch(error => {
        if (this.diffs.get(diffKey) === pending) this.diffs.delete(diffKey);
        if (!content.isConnected) return;
        delete content.dataset.loaded;
        if (error instanceof ChangesError && error.status === 409) {
          content.textContent = error.message;
          this.stale(error);
        } else {
          content.textContent = error instanceof ChangesError ? error.message : "Couldn’t load this diff.";
        }
      });
    });
    return disclosure;
  }
}
