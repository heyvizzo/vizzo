import { describe, expect, it } from "vitest";
import { parseClientMsg } from "./protocol.ts";

describe("thread lifecycle messages", () => {
  it.each([
    { type: "thread.delete.preview", requestId: "one", threadIds: ["a", "b"] },
    { type: "thread.delete", threadId: "a", mode: "keep" },
    { type: "threads.delete", requestId: "many", threads: [{ threadId: "a", mode: "commit" }, { threadId: "b", mode: "keep" }] },
    { type: "conversation.reset", requestId: "all", threads: [{ threadId: "a", mode: "keep" }] },
    { type: "conversation.reset" },
    { type: "thread.continue", threadId: "a" },
  ])("accepts $type", (message) => {
    expect(parseClientMsg(JSON.stringify(message))).toEqual(message);
  });

  it.each([
    { type: "thread.delete.preview", requestId: 1, threadIds: ["a"] },
    { type: "thread.delete.preview", requestId: "one", threadIds: ["a", "a"] },
    { type: "thread.delete", threadId: "a" },
    { type: "thread.delete", threadId: "a", mode: "discard" },
    { type: "thread.delete", threadId: "\0a", mode: "keep" },
    { type: "threads.delete", threads: [{ threadId: "a", mode: "commit" }, { threadId: "a", mode: "keep" }] },
    { type: "threads.delete", threads: { threadId: "a", mode: "keep" } },
    { type: "conversation.reset", threads: null },
    { type: "conversation.reset", threads: [{ threadId: "a", mode: [] }] },
    { type: "thread.continue", threadId: "a", config: [] },
    { type: "thread.continue", threadId: "a", turnId: 3 },
  ])("rejects malformed $type", (message) => {
    expect(parseClientMsg(JSON.stringify(message))).toBeNull();
  });
});
