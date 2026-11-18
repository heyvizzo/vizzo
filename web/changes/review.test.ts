import { describe, expect, it } from "vitest";
import type { ChangeComponent, ChangeWriter, ChangesView } from "../../shared/changes.ts";
import { ChangesReview, MessageDraft, scopeFromHash } from "./review.ts";

const a: ChangeWriter = { kind: "thread", id: "a + b/&c" };
const b: ChangeWriter = { kind: "job", id: a.id };
const component = (id: string, writers: ChangeWriter[], other = false, selectable = true): ChangeComponent => ({
  id, writers, other, selectable, files: [{ path: `${id}.txt`, entry: "text", added: 1, removed: 0 }],
});
const view: ChangesView = {
  generation: 1, branch: "refs/heads/main", base: null, changedFiles: 7, notices: [],
  groups: [
    { writer: a, title: "A", state: "open", own: ["own", "blocked", "dependent"], tied: ["mixed", "shared"] },
    { writer: b, title: "B", state: "open", own: ["job"], tied: ["shared"] },
  ],
  components: [
    component("own", [a]), component("blocked", [a], false, false), component("job", [b]),
    component("mixed", [a], true), component("shared", [a, b]), component("other", [], true),
    { ...component("dependent", [a]), requires: ["other"] },
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
    const first = draft.update(selection)!;
    const second = draft.update({ ...selection, generation: 2 })!;
    expect(draft.resolve(first, "Old selection")).toBe(false);
    expect(draft.resolve(second, "Current selection")).toBe(true);
    const third = draft.update({ ...selection, generation: 3 })!;
    draft.edit("My draft");
    expect(draft.resolve(third, "Late prefill")).toBe(false);
    expect(draft.update(undefined)).toBeUndefined();
    expect(draft.text).toBe("My draft");
    draft.edit("");
    expect(draft.update({ ...selection, generation: 4 })).toBeUndefined();
    expect(draft.text).toBe("");
  });

  it("starts a fresh prefill after reset and invalidates a request for cleared ticks", () => {
    const draft = new MessageDraft();
    const first = draft.update(selection)!;
    draft.update(undefined);
    expect(draft.resolve(first, "Cleared selection")).toBe(false);
    draft.edit("Old scope");
    draft.reset();
    expect(draft.text).toBe("");
    const latest = draft.update(selection)!;
    expect(draft.resolve(latest, "New scope")).toBe(true);
    expect(draft.text).toBe("New scope");
  });
});
