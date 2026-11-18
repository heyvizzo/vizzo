import { describe, expect, it } from "vitest";
import ompMoves from "./__fixtures__/omp-move-target.json";
import omp from "./__fixtures__/omp-rpc-edits.json";
import ompSymlinks from "./__fixtures__/omp-symlink.json";
import pi from "./__fixtures__/pi-rpc-edits.json";
import { createRpcEditEventParser, rpcEditAttributionUnavailableReason } from "./rpcEditEvents.ts";

function ompCall(number: number) {
  const toolCallId = `call_fixture_${number}`;
  const start = omp.events.find(event => event.type === "tool_execution_start" && event.toolCallId === toolCallId)!;
  const end = omp.events.find(event => event.type === "tool_execution_end" && event.toolCallId === toolCallId)!;
  return { start, end, toolCallId };
}

describe("Pi edit evidence", () => {
  it("falls back to Other given the display-only diff and write acknowledgments", () => {
    const diffs = pi.events.filter(event => event.result?.details?.diff).map(event => event.result?.details?.diff);
    expect(diffs).toEqual([
      ...Array<string>(4).fill(" 1 header\n-2 old\n+2 new\n 3 footer"),
      "-1 old\n+1 old",
    ]);
    expect(pi.events.filter(event => event.toolName === "write" && event.isError === false)).toHaveLength(3);
    expect(rpcEditAttributionUnavailableReason("pi")).toMatch(/exact before-and-after/);
    expect([pi.boot, ...pi.events, pi.reconnect].map(createRpcEditEventParser("pi")).filter(Boolean)).toEqual([]);
  });
});

describe("OhMyPi edit evidence", () => {
  it("takes each successful update and deletion's full content from the result", () => {
    const events = omp.events.map(createRpcEditEventParser("omp")).filter(event => event !== undefined);
    expect(rpcEditAttributionUnavailableReason("omp")).toBeUndefined();
    expect(events.map(event => event.toolCallId)).toEqual([1, 3, 5, 7, 9, 13, 22, 28, 30, 32].map(n => `call_fixture_${n}`));
    const file = (path: string, from: string, to: string | null) => ({ path: `/fixture/project/${path}`, from, to });
    expect(events.flatMap(event => event.changes)).toEqual([
      file("normal.txt", "header\nold\nfooter\n", "header\nnew\nfooter\n"),
      file("no-newline.txt", "header\nold\nfooter", "header\nnew\nfooter"),
      file("crlf.txt", "header\r\nold\r\nfooter\r\n", "header\r\nnew\r\nfooter\r\n"),
      file("bom.txt", "\uFEFFheader\nold\nfooter\n", "\uFEFFheader\nnew\nfooter\n"),
      file("eof.txt", "old", "new"),
      file("delete.txt", "header\nold\nfooter\n", null),
      file("multi-a.txt", "a\nold\n", "a\nnew a\n"),
      file("multi-b.txt", "b\nold\n", "b\nnew b\n"),
      file("empty-existing.txt", "", null),
      file("blank-replacement.txt", "old", ""),
      file("mixed-u8.txt", "α\r\nold\nλ\r\n", "α\r\nновый\r\nλ\r\n"),
    ]);
    expect(events.find(event => event.toolCallId === "call_fixture_22")?.changes).toHaveLength(2);
  });

  it("skips moves because the prior state of the destination is missing even on successful overwrite", () => {
    const successfulMoves = ompMoves.events.filter(event => event.isError === false);
    expect(successfulMoves.map(event => event.result?.details?.move)).toEqual([
      "/fixture/project/other-bytes.txt",
      "/fixture/project/broken-link.txt",
    ]);
    expect(successfulMoves[0]?.result?.details).toEqual({
      diff: "", op: "update", move: "/fixture/project/other-bytes.txt", sourcePath: "/fixture/project/normal.txt",
      path: "/fixture/project/other-bytes.txt", oldText: "header\nold\nfooter\n", newText: "header\nold\nfooter\n",
    });
    expect(ompMoves.events.map(createRpcEditEventParser("omp")).filter(Boolean)).toEqual([]);
  });

  it("documents the lexical paths and referent bytes that require a regular source in the ledger", () => {
    const deletions = ompSymlinks.events.filter(event => event.result?.details?.op === "delete");
    expect(deletions.map(event => event.result?.details)).toEqual([{
      diff: "", op: "delete", path: "/fixture/project/delete-link.txt", oldText: "ordinary target data\n",
    }]);
    expect(ompSymlinks.events.flatMap(event => event.result?.details?.path ?? [])).toEqual([
      "/fixture/project/delete-link.txt", "/fixture/project/edit-link.txt", "/fixture/project/linked-dir/child.txt",
    ]);
  });

  it("requires a start from the same stream and ignores repeated completions and tool call replays", () => {
    const parse = createRpcEditEventParser("omp");
    const { start, end, toolCallId } = ompCall(1);
    expect(parse(end)).toBeUndefined();
    expect(parse(start)).toBeUndefined();
    expect(parse(end)?.toolCallId).toBe(toolCallId);
    expect(parse(end)).toBeUndefined();
    expect(parse(start)).toBeUndefined();
    expect(parse(end)).toBeUndefined();
  });

  it("discards an unmatched start when opening the saved session on a new connection", () => {
    const { start, end } = ompCall(1);
    const parse = createRpcEditEventParser("omp");
    expect(parse(omp.boot)).toBeUndefined();
    expect(parse(start)).toBeUndefined();

    const reconnected = createRpcEditEventParser("omp");
    expect(omp.reconnect.data.sessionId).toBe(omp.boot.data.sessionId);
    expect(omp.reconnect.data.messageCount).toBeGreaterThan(omp.boot.data.messageCount);
    expect(reconnected(omp.reconnect)).toBeUndefined();
    expect(reconnected(end)).toBeUndefined();
  });

  it("skips malformed payloads and outcomes without explicit success", () => {
    const { start, end } = ompCall(1);
    for (const invalidStart of [null, [], { ...start, toolCallId: 1 }, { ...start, args: { input: {} } }]) {
      const parse = createRpcEditEventParser("omp");
      expect(parse(invalidStart)).toBeUndefined();
      expect(parse(end)).toBeUndefined();
    }

    const details = end.result?.details;
    for (const invalidEnd of [
      { ...end, isError: true }, { ...end, isError: undefined }, { ...end, isError: "false" }, { ...end, result: [] },
      { ...end, result: { details: { ...details, oldText: null } } },
      { ...end, result: { details: { ...details, newText: "\uD800" } } },
      { ...end, result: { details: { ...details, path: "relative.txt" } } },
      { ...end, result: { details: { ...details, op: "delete" } } },
    ]) {
      const parse = createRpcEditEventParser("omp");
      parse(start);
      expect(parse(invalidEnd)).toBeUndefined();
    }
  });

  it("rejects the entire completion when a batch contains missing evidence or repeats a path", () => {
    const { start, end } = ompCall(22);
    const files = end.result?.details?.perFileResults;
    expect(files).toHaveLength(2);
    for (const perFileResults of [[files?.[0], {}], [files?.[0], files?.[0]], []]) {
      const parse = createRpcEditEventParser("omp");
      parse(start);
      expect(parse({ ...end, result: { details: { perFileResults } } })).toBeUndefined();
    }
  });
});
