import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/opencodeEditEvents.json";
import { opencodeEditEvent } from "./opencodeEditEvents.ts";

interface FixturePatchFile {
  filePath: string;
  movePath?: string;
  type: string;
  patch: string;
}

interface FixturePart {
  id: string;
  type: string;
  sessionID: string;
  callID: string;
  tool: string;
  state: {
    status: string;
    input: Record<string, unknown>;
    metadata?: Record<string, unknown> & { files?: FixturePatchFile[]; filediff?: { patch: string } };
  };
}

interface FixtureEvent {
  id: string;
  type: string;
  properties: { part?: FixturePart };
}

const events = fixture.connections.flatMap<FixtureEvent>((connection) => connection.events);

function toolPart(callId: string, status: string) {
  const event = events.find(({ properties: { part } }) => part?.callID === callId && part.state.status === status);
  if (!event?.properties.part) throw new Error(`Missing capture for ${callId}, ${status}`);
  return { ...event, properties: { ...event.properties, part: event.properties.part } };
}

const write = toolPart("call_fixture_write_create", "completed");
const writePart = write.properties.part;
const created = {
  sessionId: writePart.sessionID,
  toolCallId: writePart.id,
  changes: [{ path: "/fixture/edit-write/created.txt", from: null, to: "created café 🌱\r\nwithout newline" }],
};

describe("OpenCode 1.19.3 edit evidence", () => {
  it("accepts a completed new write from an event or a bare part, without its start", () => {
    expect(opencodeEditEvent(write)).toEqual(created);
    expect(opencodeEditEvent(writePart)).toEqual(created);
    expect(opencodeEditEvent(toolPart("call_fixture_write_create", "pending"))).toBeUndefined();
    expect(opencodeEditEvent(toolPart("call_fixture_write_create", "running"))).toBeUndefined();
  });

  it("returns the same part ID for a repeated completion after reconnect", () => {
    const before = fixture.connections.find(({ name }) => name === "beforeReconnect")!;
    const after = fixture.connections.find(({ name }) => name === "afterReconnect")!;
    expect(before.events[0]?.type).toBe("server.connected");
    expect(after.events[0]?.type).toBe("server.connected");
    expect(before.events[0]?.id).not.toBe(after.events[0]?.id);
    expect(toolPart("call_fixture_edit", "completed").properties.part.sessionID).toBe(writePart.sessionID);
    expect(after.events.map(opencodeEditEvent).filter(Boolean)).toEqual([created]);
    expect(opencodeEditEvent(structuredClone(write))).toEqual(created);
  });

  it("distinguishes creating an empty file from overwriting a file", () => {
    const empty = { ...writePart, state: { ...writePart.state, input: { ...writePart.state.input, content: "" } } };
    expect(opencodeEditEvent(empty)?.changes).toEqual([{ path: "/fixture/edit-write/created.txt", from: null, to: "" }]);
    expect(opencodeEditEvent(toolPart("call_fixture_write_overwrite_empty", "completed"))).toBeUndefined();
    expect(opencodeEditEvent(toolPart("call_fixture_write_overwrite", "completed"))).toBeUndefined();
  });

  it("ignores failed tools and the running edit metadata", () => {
    expect(opencodeEditEvent(toolPart("call_fixture_edit_failed", "error"))).toBeUndefined();
    expect(opencodeEditEvent(toolPart("call_fixture_patch_failed", "error"))).toBeUndefined();
    for (const event of events.filter(({ properties: { part } }) => part?.tool === "edit" && part.state.status === "running")) {
      expect(opencodeEditEvent(event)).toBeUndefined();
    }
  });

  it("leaves the normalized edit diff as Other", () => {
    const edit = toolPart("call_fixture_edit", "completed");
    expect(fixture.initialFiles["/fixture/edit-write/edit.txt"]).toContain("\r\n");
    expect(edit.properties.part.state.metadata?.filediff?.patch).toContain(" one\n-old café\n+new 🌱\n last\n");
    expect(opencodeEditEvent(edit)).toBeUndefined();
  });

  it("keeps a multi-file exact patch under one part ID", () => {
    const event = toolPart("call_fixture_update", "completed");
    const part = event.properties.part;
    const files = part.state.metadata!.files!;
    expect(files.map(({ type }) => type)).toEqual(["update", "update", "update", "update"]);
    expect(opencodeEditEvent(event)).toEqual({
      sessionId: part.sessionID,
      toolCallId: part.id,
      changes: files.map(({ filePath: path, patch }) => ({ path, patch })),
    });
  });

  it("preserves CRLF and missing final newline markers in the emitted patches", () => {
    const updates = opencodeEditEvent(toolPart("call_fixture_update", "completed"))?.changes ?? [];
    expect(updates).toHaveLength(4);
    const [crlf, mixed, noEof] = updates;
    expect(crlf).toHaveProperty("patch", expect.stringContaining("-header\r\n-old\r\n-footer\r\n+header\n+new\n+footer\n"));
    expect(mixed).toHaveProperty("patch", expect.stringContaining("-old\r\n-footer\n\\ No newline at end of file\n"));
    expect(noEof).toHaveProperty("patch", expect.stringContaining("-old\n-footer\n\\ No newline at end of file\n"));

    const result = opencodeEditEvent(toolPart("call_fixture_delete_exact", "completed"));
    expect(result?.changes).toEqual([
      { path: "/fixture/patch-exact-delete/delete-crlf.txt", patch: expect.stringContaining("-footer\r\n"), to: null },
      { path: "/fixture/patch-exact-delete/delete-no-eof.txt", patch: expect.stringContaining("-footer\n\\ No newline at end of file\n"), to: null },
      { path: "/fixture/patch-exact-delete/update-lf.txt", patch: expect.stringContaining("-old\n+new\n") },
    ]);
  });

  it("rejects the entire batch if any patch row is unprovable", () => {
    const deletes = toolPart("call_fixture_delete", "completed");
    expect(fixture.initialFiles["/fixture/patch-variants/delete-empty.txt"]).toBe("");
    expect(opencodeEditEvent(deletes)).toBeUndefined();

    const part = toolPart("call_fixture_update", "completed").properties.part;
    const metadata = part.state.metadata!;
    const [first, second] = metadata.files!;
    const alias = first!.filePath.toUpperCase();
    const malformed = [
      { ...second, patch: null },
      { ...second, patch: second!.patch.replace(" header\n", "") },
      { ...first, filePath: alias, patch: first!.patch.replaceAll(first!.filePath, alias) },
    ];
    for (const row of malformed) {
      expect(opencodeEditEvent({ ...part, state: { ...part.state, metadata: { ...metadata, files: [first, row] } } })).toBeUndefined();
    }
  });

  it("leaves a batch with an add or move as Other", () => {
    const overwrite = toolPart("call_fixture_move", "completed");
    expect(fixture.initialFiles["/fixture/patch-variants/move-dst.txt"]).toBe("already here\n");
    expect(opencodeEditEvent(overwrite)).toBeUndefined();

    const mixed = toolPart("call_fixture_patch", "completed");
    const part = mixed.properties.part;
    const metadata = part.state.metadata!;
    const files = metadata.files!;
    expect(files.map(({ type }) => type)).toEqual(["update", "move", "delete", "add", "add"]);
    expect(fixture.initialFiles["/fixture/patch/overwritten-by-add.txt"]).toBe("already exists\n");
    expect(opencodeEditEvent(mixed)).toBeUndefined();
    for (const unsupported of files.filter((file) => file.type === "add" || file.type === "move")) {
      const files = [metadata.files![0], unsupported];
      expect(opencodeEditEvent({ ...part, state: { ...part.state, metadata: { ...metadata, files } } })).toBeUndefined();
    }
  });

  it("rejects malformed or incomplete parts", () => {
    const { state } = writePart;
    const malformed = [
      null,
      { ...write, properties: { part: [] } },
      { ...write, properties: { ...write.properties, sessionID: "other-session" } },
      { ...writePart, id: " " },
      { ...writePart, sessionID: null },
      { ...writePart, state: { ...state, input: { ...state.input, content: 1 } } },
      { ...writePart, state: { ...state, input: { ...state.input, content: "\uD800" } } },
      { ...writePart, state: { ...state, input: { ...state.input, filePath: "/other.txt" } } },
      { ...writePart, state: { ...state, metadata: { ...state.metadata, exists: undefined } } },
      { ...writePart, state: { ...state, metadata: { ...state.metadata, truncated: true } } },
    ];
    for (const value of malformed) expect(opencodeEditEvent(value)).toBeUndefined();
  });
});
