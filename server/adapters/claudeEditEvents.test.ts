import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeEditEvents } from "./claudeEditEvents.ts";

type Event = Parameters<ClaudeEditEvents["accept"]>[0];
interface FixtureEvent extends Event {
  session_id: string;
  message: {
    role: string;
    content: [{ type: string; id?: string; name?: string; input?: { file_path: string }; tool_use_id?: string }];
  };
}

const fixture = readFileSync(new URL("./__fixtures__/claude-edit-events-v2.1.327.jsonl", import.meta.url), "utf8")
  .trimEnd().split("\n").map((line): FixtureEvent => JSON.parse(line));

function recordedCall(name: string) {
  const path = `/fixture/project/${name}`;
  const index = fixture.findIndex((event) => event.message.content[0].input?.file_path === path);
  const start = fixture[index]!;
  const completion = fixture[index + 1]!;
  return { start, completion, path, sessionId: start.session_id, toolCallId: start.message.content[0].id! };
}

describe("Claude Code edit evidence", () => {
  const create = recordedCall("new.txt");
  const output = [{
    sessionId: create.sessionId,
    toolCallId: create.toolCallId,
    changes: [{ path: create.path, from: null, to: "crée\n" }],
  }];

  it("emits recorded Write creates, distinguishing empty content from absence", () => {
    const empty = recordedCall("empty.txt");
    const adapter = new ClaudeEditEvents();
    expect(fixture.flatMap((event) => adapter.accept(event))).toEqual([
      ...output,
      {
        sessionId: empty.sessionId,
        toolCallId: empty.toolCallId,
        changes: [{ path: empty.path, from: null, to: "" }],
      },
    ]);
  });

  it("skips Edit results whose line-ending evidence is ambiguous", () => {
    const { filePath: _path, ...lf } = recordedCall("lf.txt").completion.tool_use_result as Record<string, unknown>;
    expect(lf.originalFile).toBe("header\norange café\nfooter\n");
    for (const name of ["lf.txt", "crlf.txt", "mixed.txt", "no-final.txt"]) {
      const { start, completion } = recordedCall(name);
      if (name === "crlf.txt" || name === "mixed.txt") {
        expect(completion.tool_use_result).toMatchObject(lf);
      }
      const adapter = new ClaudeEditEvents();
      expect(adapter.accept(start)).toEqual([]);
      expect(adapter.accept(completion)).toEqual([]);
    }
  });

  it.each(["rewrite.txt", "unread.txt"])("skips the recorded overwrite or failed Write to %s", (name) => {
    const { start, completion } = recordedCall(name);
    const adapter = new ClaudeEditEvents();
    expect(adapter.accept(start)).toEqual([]);
    expect(adapter.accept(completion)).toEqual([]);
  });

  it("keeps literal CRLF, UTF-8 and a missing final newline in reported content", () => {
    const to = "crée\r\n🦦\r\nfin";
    const call = create.start.message.content[0];
    const start = { ...create.start, message: { role: "assistant", content: [{ ...call, input: { ...call.input, content: to } }] } };
    const attachment = create.completion.tool_use_result as Record<string, unknown>;
    const adapter = new ClaudeEditEvents();
    adapter.accept(start);
    expect(adapter.accept({ ...create.completion, tool_use_result: { ...attachment, content: to } })).toEqual([{
      sessionId: create.sessionId,
      toolCallId: create.toolCallId,
      changes: [{ path: create.path, from: null, to }],
    }]);
  });

  it("dedupes a repeated completion and full replay across reconnect", () => {
    const adapter = new ClaudeEditEvents();
    adapter.accept(create.start);
    expect(adapter.accept(create.completion)).toEqual(output);
    expect(adapter.accept(create.completion)).toEqual([]);
    adapter.accept({ type: "system", subtype: "init", session_id: create.sessionId });
    adapter.accept(create.start);
    expect(adapter.accept(create.completion)).toEqual([]);
  });

  it("correlates the tool call within its harness session", () => {
    const adapter = new ClaudeEditEvents();
    expect(adapter.accept(create.completion)).toEqual([]);
    adapter.accept(create.start);
    expect(adapter.accept({ ...create.completion, session_id: "other-session" })).toEqual([]);
    expect(adapter.accept(create.completion)).toEqual(output);

    adapter.accept({ ...create.start, session_id: "other-session" });
    expect(adapter.accept({ ...create.completion, session_id: "other-session" })).toEqual([
      { ...output[0], sessionId: "other-session" },
    ]);
  });

  it("ignores partial starts and declines conflicting starts with the same tool identity", () => {
    const block = create.start.message.content[0];
    const differentPath = { ...block, input: { ...block.input, file_path: "/fixture/project/different.txt" } };
    const adapter = new ClaudeEditEvents();
    adapter.accept({ ...create.start, type: "stream_event" });
    expect(adapter.accept(create.completion)).toEqual([]);
    adapter.accept(create.start);
    adapter.accept({ ...create.start, message: { role: "assistant", content: [differentPath] } });
    expect(adapter.accept(create.completion)).toEqual([]);
  });

  it.each(["MultiEdit", "NotebookEdit"])("ignores %s", (name) => {
    const adapter = new ClaudeEditEvents();
    const call = { ...create.start.message.content[0], name };
    adapter.accept({ ...create.start, message: { role: "assistant", content: [call] } });
    expect(adapter.accept(create.completion)).toEqual([]);
  });

  it.each([
    { type: "update" },
    { originalFile: undefined },
    { originalFile: "" },
    { content: undefined },
    { content: "\uD800" },
    { filePath: "/fixture/project/different.txt" },
    { userModified: true },
    { userModified: undefined },
    { structuredPatch: [{ lines: ["+content"] }] },
    { structuredPatch: undefined },
  ])("rejects malformed or unsupported attachments such as %j", (patch) => {
    const adapter = new ClaudeEditEvents();
    adapter.accept(create.start);
    const attachment = create.completion.tool_use_result as Record<string, unknown>;
    expect(adapter.accept({ ...create.completion, tool_use_result: { ...attachment, ...patch } })).toEqual([]);
    adapter.accept(create.start);
    expect(adapter.accept(create.completion)).toEqual([]);
  });

  it.each([
    [],
    [{ ...create.completion.message.content[0], is_error: true }],
    [{ ...create.completion.message.content[0], content: undefined }],
    [...create.completion.message.content, { type: "tool_result", tool_use_id: "another-tool" }],
  ].map((content) => ({ content })))("requires a single successful completed result block", ({ content }) => {
    const adapter = new ClaudeEditEvents();
    adapter.accept(create.start);
    expect(adapter.accept({ ...create.completion, message: { role: "user", content } })).toEqual([]);
  });
});
