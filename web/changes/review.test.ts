import { describe, expect, it } from "vitest";
import type { ChangeComponent, ChangeWriter, ChangesView } from "../../shared/changes.ts";
import { ChangesReview, MessageDraft, scopeFromHash } from "./review.ts";

const a: ChangeWriter = { kind: "thread", id: "a + b/&c" };
const b: ChangeWriter = { kind: "job", id: a.id };
const c: ChangeWriter = { kind: "thread", id: "c" };
const component = (id: string, writers: ChangeWriter[], other = false, selectable = true): ChangeComponent => ({
  id, writers, other, selectable, files: [{ path: `${id}.txt`, entry: "text", added: 1, removed: 0 }],
});
const view: ChangesView = {
  generation: 1, branch: "refs/heads/main", base: null, changedFiles: 8, notices: [],
  groups: [
    { writer: a, title: "A", state: "open", own: ["own", "blocked", "dependent"], tied: ["mixed", "shared"] },
    { writer: b, title: "B", state: "open", own: ["job"], tied: ["shared"] },
    { writer: c, title: "C", state: "closed", own: ["closed"], tied: [] },
  ],
  components: [
    component("own", [a]), component("blocked", [a], false, false), component("job", [b]),
    component("mixed", [a], true), component("shared", [a, b]), component("other", [], true),
    { ...component("dependent", [a]), requires: ["other"] },
    component("closed", [c]),
  ],
};

describe("Changes review", () => {
  it("resets the scope on each open and prechecks only eligible own components", () => {
    const review = new ChangesReview();
    const scope = scopeFromHash(`#thread=${encodeURIComponent(a.id)}`);
    expect(scope).toBe(a.id);
    review.open(scope);
    review.apply("project", view);
    expect(review.scopedGroup?.writer).toEqual(a);
    expect(review.selection?.components).toEqual(["own"]);
    for (const id of ["shared", "other", "mixed", "blocked"]) review.toggle(id, true);
    expect(review.selection?.components).toEqual(["mixed", "other", "own", "shared"]);

    review.open(scope);
    review.apply("project", view);
    expect(review.selection?.components).toEqual(["own"]);
    review.open(scopeFromHash(""));
    review.apply("project", view);
    expect(review.selection).toBeUndefined();
  });

  it("selects every eligible component across a scoped review and clears them together", () => {
    const review = new ChangesReview();
    review.open(a.id);
    review.apply("project", view);
    expect(review.selectAllState).toEqual({ checked: false, indeterminate: true, available: true, includesOther: true });

    review.toggleAll(true);
    expect(review.selection).toEqual({
      project: "project", generation: 1, components: ["closed", "dependent", "job", "mixed", "other", "own", "shared"],
    });
    expect(review.missingRequirement).toBeUndefined();
    expect(review.selectAllState).toMatchObject({ checked: true, indeterminate: false });
    review.toggle("other", false);
    expect(review.selectAllState).toMatchObject({ checked: false, indeterminate: true });
    expect(review.selection).toBeUndefined();

    review.toggleAll(false);
    expect(review.selectAllState).toMatchObject({ checked: false, indeterminate: false });
    expect(review.selection).toBeUndefined();
    review.apply("project", { ...view, generation: 2 });
    expect(review.selection).toBeUndefined();
  });

  it("never extends a bulk selection to new, replaced, or newly eligible IDs on refresh", () => {
    const review = new ChangesReview();
    review.apply("project", view);
    review.toggleAll(true);
    const next = { ...view, generation: 2, components: [
      ...view.components.filter(item => !["blocked", "mixed", "shared"].includes(item.id)),
      component("blocked", [a]), component("mixed-new", [a], true), component("new", [a]),
      component("shared", [a, b], false, false),
    ] };
    review.apply("project", next);
    expect(review.selection).toEqual({
      project: "project", generation: 2, components: ["closed", "dependent", "job", "other", "own"],
    });
    expect(review.selectAllState).toMatchObject({ checked: false, indeterminate: true });

    review.apply("next project", view);
    expect(review.selection).toBeUndefined();
    review.apply("next project", { ...view, components: [component("blocked", [a], true, false)] });
    expect(review.selectAllState).toEqual({ checked: false, indeterminate: false, available: false, includesOther: false });
  });

  it("keeps only exact eligible ticks on refresh, including explicit Other selections", () => {
    const review = new ChangesReview();
    review.open(a.id);
    review.apply("project", view);
    review.toggle("mixed", true);
    review.toggle("other", true);
    const next = { ...view, generation: 2, components: [
      ...view.components.filter(item => item.id !== "own" && item.id !== "mixed"),
      component("mixed-new", [a], true), component("new", [a]),
    ] };
    review.apply("project", next);
    expect(review.selection).toEqual({ project: "project", generation: 2, components: ["other"] });

    review.invalidate();
    review.apply("project", { ...view, generation: 3 });
    expect(review.selection).toBeUndefined();
    review.toggle("own", true);
    review.apply("next project", view);
    expect(review.selection).toBeUndefined();
  });

  it("requires the user to tick prerequisites, including Other", () => {
    const review = new ChangesReview();
    review.apply("project", view);
    review.toggle("dependent", true);
    expect(review.missingRequirement?.id).toBe("other");
    expect(review.selection).toBeUndefined();
    review.toggle("other", true);
    expect(review.selection?.components).toEqual(["dependent", "other"]);
    review.toggle("other", false);
    expect(review.selection).toBeUndefined();
  });
});

describe("message draft", () => {
  const selection = { project: "project", generation: 1, components: ["own"] };

  it("ignores an out-of-date prefill and preserves user edits, even an empty message", () => {
    const draft = new MessageDraft();
    expect(draft.update(selection)).toBe(true);
    const first = draft.begin(false)!;
    expect(draft.update(selection)).toBe(false);
    draft.update({ ...selection, generation: 2 });
    const second = draft.begin(false)!;
    expect(draft.resolve(first, "Old selection")).toBe(false);
    expect(draft.resolve(second, "Current selection")).toBe(true);
    draft.update({ ...selection, generation: 3 });
    const third = draft.begin(false)!;
    draft.edit("My draft");
    expect(draft.resolve(third, "Late prefill")).toBe(false);
    draft.update(undefined);
    expect(draft.text).toBe("My draft");
    draft.edit("");
    draft.update({ ...selection, generation: 4 });
    expect(draft.begin(false)).toBeUndefined();
    expect(draft.text).toBe("");
  });

  it("starts a fresh prefill after reset and invalidates a request for cleared ticks", () => {
    const draft = new MessageDraft();
    draft.update(selection);
    const first = draft.begin(false)!;
    draft.update(undefined);
    expect(draft.resolve(first, "Cleared selection")).toBe(false);
    draft.edit("Old scope");
    draft.reset();
    expect(draft.text).toBe("");
    draft.update(selection);
    const latest = draft.begin(false)!;
    expect(draft.resolve(latest, "New scope")).toBe(true);
    expect(draft.text).toBe("New scope");
  });

  it("only replaces custom text after a manual request for the current selection succeeds", () => {
    const draft = new MessageDraft();
    expect(draft.begin(true)).toBeUndefined();
    draft.update(selection);
    draft.edit("Custom draft");
    expect(draft.begin(false)).toBeUndefined();
    const outdated = draft.begin(true)!;
    draft.update({ ...selection, generation: 2 });
    expect(draft.resolve(outdated, "Old selection")).toBe(false);
    const current = draft.begin(true)!;
    expect(draft.text).toBe("Custom draft");
    expect(draft.resolve(current, "New message")).toBe(true);
    expect(draft.text).toBe("New message");
    expect(draft.begin(false)).toBeUndefined();
    draft.update(selection);
    expect(draft.text).toBe("");
    expect(draft.begin(false)).toBeTypeOf("number");
  });
});
