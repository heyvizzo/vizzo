import { describe, expect, it } from "vitest";
import capture from "./__fixtures__/codex-0.170.0-edit-events.json";
import { parseCodexEditEvent } from "./codexEditEvents.ts";

function parse(wire: { method: string; params: unknown }) {
  return parseCodexEditEvent(wire.method, wire.params);
}

const [start, completion] = capture.exactBatch.wire;
const params = completion!.params;
const [deletion, , , update] = params.item.changes;

describe("Codex edit events", () => {
  it("uses the completion alone and emits one batch for exact deletes and updates", () => {
    expect(parse(start!)).toBeNull();
    const { before } = capture.exactBatch.disk;
    expect(parse(completion!)).toEqual({
      sessionId: params.threadId,
      toolCallId: JSON.stringify([params.turnId, params.item.id]),
      changes: [
        { path: "/fixture/project/delete.txt", from: before["delete.txt"], to: null },
        { path: "/fixture/project/empty-delete.txt", from: "", to: null },
        {
          path: "/fixture/project/long.txt",
          patch: "@@ -2,3 +2,3 @@\n line 1\n-line 2\n+TWO\n line 3\n@@ -75,3 +75,3 @@\n line 74\n-line 75\n+SEVENTY FIVE\n line 76\n",
        },
        { path: "/fixture/project/update.txt", patch: "@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n" },
      ],
    });
  });

  it("preserves CRLF and missing-newline markers from the wire", () => {
    const batch = parse(capture.endings.wire[0]!);
    expect(batch?.changes).toEqual([
      { path: "/fixture/project/crlf.txt", patch: "@@ -1,3 +1,3 @@\n alpha\r\n-beta\r\n+BETA\r\n last\r\n" },
      { path: "/fixture/project/eof-end.txt", patch: "@@ -1,2 +1,2 @@\n alpha\n-last\n\\ No newline at end of file\n+LAST\n" },
      { path: "/fixture/project/eof.txt", patch: "@@ -1,3 +1,3 @@\n alpha\n-beta\n-last\n\\ No newline at end of file\n+BETA\n+last\n" },
    ]);
    expect(capture.endings.disk.after["crlf.txt"]).toBe("alpha\r\nBETA\r\nlast\r\n");
    expect(capture.endings.disk.before["eof-end.txt"]).toBe("alpha\nlast");
    expect(capture.endings.disk.after["eof-end.txt"]).toBe("alpha\nLAST\n");
  });

  it("identifies repeated completion and reconnect history with the native IDs", () => {
    const first = parse(completion!);
    expect(first).not.toBeNull();
    expect(parse({ ...completion!, params: { ...params, completedAtMs: 1 } })).toEqual(first);

    const resume = capture.exactBatch.resumeResponse;
    const { thread } = resume.result;
    const turn = thread.turns[0]!;
    expect(parseCodexEditEvent("thread/resume", resume)).toBeNull();
    expect(parseCodexEditEvent("item/completed", { threadId: thread.id, turnId: turn.id, item: turn.items[0] })).toEqual(first);
    expect(parseCodexEditEvent("item/completed", { ...params, turnId: "different-turn" })?.toolCallId).not.toBe(first?.toolCallId);
    expect(parseCodexEditEvent("item/completed", { ...params, threadId: "different-session" })?.sessionId).not.toBe(first?.sessionId);
  });

  it.each([
    ["a new file", capture.addNew],
    ["an add that overwrote a file", capture.addOverwrite],
    ["a move to an absent destination", capture.moveNew],
    ["a move that overwrote a file", capture.moveOverwrite],
    ["a move with no source patch", capture.pureMove],
    ["a case-only move that removed the entry", capture.caseOnlyMove],
    ["updates to two case aliases", capture.caseAliasedUpdates],
    ["a mix of exact rows and adds", capture.mixedUnsupported],
    ["a context-free insertion", capture.unwitnessedInsertion],
    ["a failed patch before an item started", capture.failedBeforeLifecycle],
    ["a failed patch that partially wrote", capture.partialWrite],
    ["an interrupted turn during approval", capture.cancelled],
    ["a declined patch", capture.declined],
  ])("rejects %s", (_label, scenario) => {
    expect(scenario.wire.map(parse)).toEqual(scenario.wire.map(() => null));
  });

  it("records the same change payload for creation and overwrite", () => {
    expect(capture.addNew.wire[0]!.params.item.changes).toEqual(capture.addOverwrite.wire[0]!.params.item.changes);
    expect(capture.moveNew.wire[0]!.params.item.changes).toEqual(capture.moveOverwrite.wire[0]!.params.item.changes);
    expect(capture.addNew.disk.before).toEqual({});
    expect(capture.addOverwrite.disk.before["same.txt"]).toBe("old result\n");
    expect(capture.moveNew.disk.before).toEqual({ "same.txt": "alpha\nbeta\ngamma\n" });
    expect(capture.moveOverwrite.disk.before["destination.txt"]).toBe("old destination\n");
    expect(capture.caseOnlyMove.disk.after).toEqual({});
    expect(capture.partialWrite.disk.after["first.txt"]).toBe("first written\n");
  });

  it.each([
    null,
    { ...params, threadId: undefined },
    { ...params, turnId: "" },
    { ...params, item: { ...params.item, id: 12 } },
    { ...params, item: { ...params.item, type: "commandExecution" } },
    { ...params, item: { ...params.item, status: "inProgress" } },
    { ...params, item: { ...params.item, changes: [] } },
  ])("rejects a malformed completion", (malformed) => {
    expect(parseCodexEditEvent("item/completed", malformed)).toBeNull();
  });

  it.each([
    null,
    deletion,
    { ...deletion, path: "relative.txt" },
    { ...deletion, path: "/fixture/project/inner/../delete.txt" },
    { ...deletion, diff: undefined },
    { ...update, kind: { type: "update" } },
    { ...update, diff: "@@\n-beta\n+BETA\n" },
    { ...update, diff: "@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n" },
    { ...update, diff: "@@ -1 +1 @@\n-beta\n+BETA\nnew trailing data" },
    { ...update, diff: "@@ -1 +2 @@\n-beta\n+BETA\n" },
    { ...update, diff: "@@ -1,2 +1,2 @@\n-beta\n\\ No newline at end of file\n-old\n+BETA\n+new\n" },
  ])("rejects the whole batch if a row is malformed or collides with another", (malformed) => {
    expect(parseCodexEditEvent("item/completed", { ...params, item: { ...params.item, changes: [deletion, malformed] } })).toBeNull();
  });
});
