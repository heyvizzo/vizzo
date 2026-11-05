import { beforeEach, describe, expect, it } from "vitest";
import type { ThreadAnchor } from "../../shared/threads.ts";
import type { RouteDecision } from "../adapters/types.ts";
import { resetThreadStore } from "./store.ts";
import { planThread, prepareThreads, type TurnThreads } from "./turn.ts";

const RED: ThreadAnchor = {
  pageUrl: "http://localhost/demo.html", selector: "#red", domPath: "body > #red", dataSource: null, label: "Get started", text: "Get started",
  role: null, tag: "button", bounds: { x: 0, y: 0, width: 100, height: 40 },
};

const task = (target: RouteDecision["target"]): RouteDecision => ({ intent: "task", estimateS: 60, target });

function threads(over: Partial<TurnThreads> = {}): TurnThreads {
  return { anchor: RED, anchorLabel: "the red button", briefs: [], ...over };
}

beforeEach(() => { resetThreadStore(); });

describe("planThread", () => {
  it("a spoken click still places a marker when the router says central", () => {
    const plan = planThread(task({ kind: "central" }), threads({ clicked: true }));
    expect(plan).toMatchObject({ relation: "new" });
    expect(plan?.threadId).toBeTruthy();
  });

  it("a spoken click on an element that already has a thread uses that marker", () => {
    const store = resetThreadStore();
    const existing = store.create(RED, "the red button", "task");
    const plan = planThread(task({ kind: "central" }), threads({ clicked: true, matched: existing.threadId }), store);
    expect(plan).toEqual({ threadId: existing.threadId, relation: "followup" });
    expect(store.list()).toHaveLength(1);
  });

  it("spoken: naming another thread moves the marker there", () => {
    const store = resetThreadStore();
    const other = store.create({ ...RED, selector: "#blue", domPath: "body > #blue" }, "the blue button", "task");
    const plan = planThread(
      task({ kind: "thread", threadId: other.threadId, relation: "correction" }),
      threads({ clicked: true }),
      store,
    );
    expect(plan).toEqual({ threadId: other.threadId, relation: "correction" });
    expect(store.list()).toHaveLength(1);
  });

  it("a panel open: the turn stays on its thread, even when another thread is named", () => {
    const store = resetThreadStore();
    const open = store.create(RED, "the red button", "task");
    const other = store.create({ ...RED, selector: "#blue", domPath: "body > #blue" }, "the blue button", "task");
    const stay = planThread(task({ kind: "central" }), threads({ pinned: open.threadId }), store);
    expect(stay).toEqual({ threadId: open.threadId, relation: "followup" });
    const named = planThread(
      task({ kind: "thread", threadId: other.threadId, relation: "correction" }),
      threads({ pinned: open.threadId }),
      store,
    );
    expect(named).toEqual({ threadId: open.threadId, relation: "followup" });
    expect(planThread({ intent: "answer", estimateS: null, tell: other.threadId }, threads({ pinned: open.threadId }), store))
      .toEqual({ threadId: open.threadId, relation: "followup" });
  });

  it("a panel whose thread is gone: the turn goes nowhere, not to the element under the cursor", () => {
    const store = resetThreadStore();
    const red = store.create(RED, "the red button", "task");
    const tt = prepareThreads({ words: [], pointing: [], rests: [], samples: [], pageUrl: RED.pageUrl }, store, "gone", { typed: true });
    expect(tt).toEqual({ anchor: null, briefs: [], pinnedMissing: true });
    expect(planThread(task({ kind: "thread", threadId: red.threadId, relation: "followup" }), tt, store)).toBeNull();
    expect(store.list()).toHaveLength(1);
  });

  it("typed: the click wins, even when the text names another thread", () => {
    const store = resetThreadStore();
    const here = store.create(RED, "the red button", "task");
    const other = store.create({ ...RED, selector: "#blue", domPath: "body > #blue" }, "the blue button", "task");
    const plan = planThread(
      task({ kind: "thread", threadId: other.threadId, relation: "correction" }),
      threads({ typed: true, matched: here.threadId }),
      store,
    );
    expect(plan).toEqual({ threadId: here.threadId, relation: "followup" });
    expect(store.list()).toHaveLength(2);
  });

  it("message box: always stays in the central conversation, even when a thread is named", () => {
    const store = resetThreadStore();
    const red = store.create(RED, "the red button", "task");
    const box = (over: Partial<TurnThreads> = {}): TurnThreads => ({ anchor: null, briefs: [], chat: true, ...over });
    expect(planThread(task({ kind: "thread", threadId: red.threadId, relation: "correction" }), box(), store)).toBeNull();
    expect(planThread({ intent: "answer", estimateS: null, tell: red.threadId }, box(), store)).toBeNull();
    expect(planThread(task({ kind: "new" }), box(), store)).toBeNull();
    expect(planThread(task({ kind: "central" }), box(), store)).toBeNull();
    expect(store.list()).toHaveLength(1);
  });

  it("message box: the router hears about every thread, none under the cursor", () => {
    const store = resetThreadStore();
    const red = store.create(RED, "the red button", "task");
    const tt = prepareThreads({ words: [], pointing: [], rests: [], samples: [], pageUrl: RED.pageUrl }, store, undefined, { chat: true });
    expect(tt).toMatchObject({ anchor: null, chat: true });
    expect(tt.briefs).toEqual([expect.objectContaining({ threadId: red.threadId, onCurrentPage: true, underCursor: false })]);
  });

  it("pointing without a click can still go to the central conversation", () => {
    expect(planThread(task({ kind: "central" }), threads())).toBeNull();
  });

  it("a click does not open a thread for a clarification", () => {
    const d: RouteDecision = { intent: "clarify", estimateS: null, target: { kind: "central" } };
    expect(planThread(d, threads({ clicked: true }))).toBeNull();
    expect(planThread(d, threads({ typed: true }))).toBeNull();
  });
});
