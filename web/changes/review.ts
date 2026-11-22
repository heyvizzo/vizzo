import type { ChangeComponent, ChangeGroup, ChangesMessageResult, ChangesSelectionRequest, ChangesView } from "../../shared/changes.ts";

export function scopeFromHash(hash: string): string | null {
  return new URLSearchParams(hash.slice(1)).get("thread") || null;
}

export class ChangesReview {
  project: string | undefined;
  view: ChangesView | undefined;
  scope: string | null = null;
  components = new Map<string, ChangeComponent>();
  selected = new Set<string>();
  private initialSelection = true;

  open(scope: string | null): void {
    this.scope = scope;
    this.initialSelection = true;
    this.selected.clear();
  }

  suspend(): void {
    this.view = undefined;
    this.components.clear();
    this.selected.clear();
  }

  invalidate(): void {
    this.selected.clear();
    this.initialSelection = false;
  }

  apply(project: string, view: ChangesView): void {
    if (this.project !== undefined && this.project !== project) this.selected.clear();
    this.project = project;
    this.view = view;
    this.components = new Map(view.components.map(component => [component.id, component]));
    this.selected = new Set([...this.selected].filter(id => this.components.get(id)?.selectable));

    if (this.initialSelection) {
      this.initialSelection = false;
      for (const id of this.scopedGroup?.own ?? []) {
        const component = this.components.get(id);
        const writer = component?.writers[0];
        if (component?.selectable && !component.other && component.writers.length === 1 &&
            writer?.kind === "thread" && writer.id === this.scope) this.selected.add(id);
      }
      // A scope never auto-selects another writer or Other to satisfy a prerequisite.
      for (const id of this.selected) {
        if (this.components.get(id)?.requires?.some(required => !this.selected.has(required))) this.selected.delete(id);
      }
    }
  }

  get scopedGroup(): ChangeGroup | undefined {
    return this.scope === null ? undefined : this.view?.groups.find(({ writer }) => writer.kind === "thread" && writer.id === this.scope);
  }

  toggle(id: string, checked: boolean): void {
    if (checked && this.components.get(id)?.selectable) this.selected.add(id);
    else this.selected.delete(id);
  }

  toggleAll(checked: boolean): void {
    this.selected.clear();
    if (!checked) return;
    for (const component of this.components.values()) {
      if (component.selectable) this.selected.add(component.id);
    }
  }

  /** Ticks or clears every listed component, as one card's header checkbox does. */
  toggleMany(ids: readonly string[], checked: boolean): void {
    for (const id of ids) this.toggle(id, checked);
  }

  selectManyState(ids: readonly string[]): { checked: boolean; indeterminate: boolean; available: boolean } {
    const selectable = ids.filter(id => this.components.get(id)?.selectable);
    const picked = selectable.filter(id => this.selected.has(id)).length;
    const checked = selectable.length > 0 && picked === selectable.length;
    return { checked, indeterminate: picked > 0 && !checked, available: selectable.length > 0 };
  }

  get selectAllState(): { checked: boolean; indeterminate: boolean; available: boolean; includesOther: boolean } {
    let selectable = 0;
    let includesOther = false;
    for (const component of this.components.values()) {
      if (!component.selectable) continue;
      selectable++;
      includesOther ||= component.other;
    }
    const checked = selectable > 0 && this.selected.size === selectable;
    return { checked, indeterminate: this.selected.size > 0 && !checked, available: selectable > 0, includesOther };
  }

  get missingRequirement(): ChangeComponent | undefined {
    for (const id of this.selected) {
      for (const required of this.components.get(id)?.requires ?? []) {
        if (!this.selected.has(required)) return this.components.get(required);
      }
    }
  }

  get selection(): ChangesSelectionRequest | undefined {
    if (!this.project || !this.view || !this.selected.size || this.missingRequirement) return;
    return { project: this.project, generation: this.view.generation, components: [...this.selected].sort() };
  }
}

/** Generated text belongs to the selection. A user edit is kept even if it blanks the field. */
export class MessageDraft {
  text = "";
  private edited = false;
  private selectionKey = "";
  private version = 0;

  reset(): void {
    this.text = "";
    this.edited = false;
    this.selectionKey = "";
    this.version++;
  }

  edit(text: string): void {
    this.text = text;
    this.edited = true;
    this.version++;
  }

  update(selection: ChangesSelectionRequest | undefined): boolean {
    const key = selection ? JSON.stringify(selection) : "";
    if (key === this.selectionKey) return false;
    this.selectionKey = key;
    this.version++;
    if (!this.edited) this.text = "";
    return true;
  }

  begin(manual: boolean): number | undefined {
    if (!this.selectionKey || (!manual && (this.edited || this.text))) return;
    return ++this.version;
  }

  resolve(version: number, result: ChangesMessageResult): "filled" | "kept" | undefined {
    if (version !== this.version) return;
    if (result.status === "fallback" && this.text.trim()) return "kept";
    this.text = result.message;
    this.edited = false;
    return "filled";
  }
}
