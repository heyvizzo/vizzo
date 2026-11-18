#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { join } from "node:path";

const harness = process.env.VIZZO_FAKE_NATIVE_HARNESS;
const mode = process.env.VIZZO_FAKE_STOP_MODE;
const late = mode === "late";
const descendant = mode === "descendant";
const sid = "native-session";
const tid = "native-turn";
const text = "working";
const stdout = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const afterStop = (fn) => setTimeout(fn, 60);
const terminal = () => { if (descendant) writeFileSync("terminal", ""); };
const childWriter = () => {
  writeFileSync("created", "proved");
  return spawn(process.execPath, ["-e", `
    const { existsSync, writeFileSync } = require("node:fs");
    setInterval(() => {
      if (!existsSync("release-descendant")) return;
      writeFileSync("created", "late");
      process.exit(0);
    }, 10);
  `], { stdio: "ignore" });
};

if (harness === "opencode") {
  const ports = process.argv.slice(2);
  const port = Number(ports[ports.indexOf("--port") + 1]);
  const streams = new Set();
  let messageId;
  let promptResponse;
  let dir;
  const partId = "part-native";
  const info = (id, parentID) => ({ id, parentID, sessionID: sid });
  const send = (type, properties) => {
    for (const stream of streams) stream.write("data: " + JSON.stringify({ type, properties }) + "\n\n");
  };
  createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const respond = (value) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"server.connected"}\n\n');
      streams.add(res);
      res.on("close", () => streams.delete(res));
    } else if (url.pathname === "/session" && req.method === "POST") respond({ id: sid });
    else if (url.pathname.endsWith("/message")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      ({ messageID: messageId } = JSON.parse(raw));
      dir = url.searchParams.get("directory");
      promptResponse = respond;
      send("message.updated", { info: info(messageId) });
      send("message.updated", { info: info("assistant-current", messageId) });
      send("message.part.updated", { part: { id: "text", type: "text", sessionID: sid } });
      send("message.part.delta", { sessionID: sid, partID: "text", field: "text", delta: text });
    } else if (url.pathname.endsWith("/abort")) {
      respond(true);
      afterStop(() => {
        for (const [id, messageID] of [["part-stale", "assistant-previous"], [partId, "assistant-current"]]) {
          const path = join(dir, "created");
          send("message.part.updated", { part: {
            id, messageID, sessionID: sid, type: "tool", tool: "write",
            state: { status: "completed", input: { content: "late", filePath: path }, metadata: { truncated: false, exists: false, filepath: path } },
          } });
        }
        if (late) {
          send("session.idle", { sessionID: "another-session" });
          promptResponse({ info: info("assistant-current", messageId), parts: [{ type: "text", text }] });
          send("session.idle", { sessionID: sid });
        }
      });
    } else respond(true);
  }).listen(port, "127.0.0.1", () => console.log(`opencode server listening on http://127.0.0.1:${port}`));
} else if (harness === "grok") {
  if (descendant) childWriter().on("exit", () => process.exit(0));
  stdout({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
  process.on("SIGTERM", () => { if (late || descendant) afterStop(() => {
    stdout({ type: "result", subtype: "success" });
    terminal();
    if (late) process.exit(0);
  }); });
  setInterval(() => {}, 1000);
} else {
  const inLines = createInterface({ input: process.stdin });
  let turn = 0;
  inLines.on("line", (line) => {
    const m = JSON.parse(line);
    if (harness === "codex") {
      const receive = (method, params) => stdout({ method, params: { threadId: sid, ...params } });
      const reply = (result) => stdout({ id: m.id, result });
      if (m.method === "initialize" || m.method === "config/read") reply({});
      if (m.method === "thread/start" || m.method === "thread/resume") reply({ thread: { id: sid } });
      if (m.method === "turn/start") {
        reply({ turn: { id: tid } });
        receive("item/agentMessage/delta", { turnId: tid, delta: text });
      }
      if (m.method === "turn/interrupt") {
        reply({});
        afterStop(() => {
          receive("turn/completed", { turn: { id: "prior-turn", status: "interrupted" } });
          const fileChange = { id: "native-tool", type: "fileChange", status: "completed", changes: [
            { path: join(process.env.VIZZO_FAKE_PROJECT, "f"), kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-before\n+after\n" },
          ] };
          receive("item/completed", { turnId: "prior-turn", item: fileChange });
          receive("item/completed", { turnId: tid, item: fileChange });
          if (late) receive("turn/completed", { turn: { id: tid, status: "interrupted" } });
        });
      }
      if (m.method === "thread/unsubscribe") reply({ status: "notLoaded" });
    } else if (harness === "claude-code") {
      const receive = (value) => stdout({ session_id: sid, ...value });
      if (m.type === "user") {
        if (descendant && ++turn > 1) { receive({ type: "result", subtype: "success", result: "resumed" }); return; }
        if (descendant) childWriter();
        receive({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
      }
      if (m.type === "control_request") afterStop(() => {
        const path = join(process.cwd(), "created");
        const content = descendant ? "proved" : "late";
        const report = () => {
          receive({ type: "assistant", message: { role: "assistant", content: [
            { type: "tool_use", id: "native-tool", name: "Write", input: { file_path: path, content } },
          ] } });
          receive({ type: "user", message: { role: "user", content: [
            { type: "tool_result", tool_use_id: "native-tool", content: "Written" },
          ] }, tool_use_result: {
            type: "create", filePath: path, originalFile: null, structuredPatch: [], userModified: false, content,
          } });
          if (late) receive({ type: "result", subtype: "success" });
        };
        if (descendant) { receive({ type: "result", subtype: "success" }); terminal(); afterStop(report); }
        else report();
      });
    } else {
      if (m.type === "get_state") stdout({ type: "response", id: "boot", data: { sessionId: sid, messageCount: 0 } });
      if (m.type === "prompt") {
        if (descendant && ++turn > 1) {
          stdout({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "resumed" } });
          stdout({ type: "agent_end" });
          return;
        }
        if (descendant) childWriter();
        stdout({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
      }
      if (m.type === "abort") afterStop(() => {
        if (mode === "reject-prompt") {
          stdout({ type: "response", id: "prompt", success: false });
          writeFileSync("rejected", "");
          const wait = setInterval(() => {
            if (!existsSync("release-terminal")) return;
            clearInterval(wait);
            stdout({ type: "agent_end" });
          }, 10);
          return;
        }
        const report = () => {
          stdout({ type: "tool_execution_start", toolCallId: "native-tool", toolName: "edit", args: { input: "exact" } });
          stdout({ type: "tool_execution_end", toolCallId: "native-tool", toolName: "edit", isError: false,
            result: { details: { path: join(process.cwd(), descendant ? "created" : "f"), op: "update", oldText: "before", newText: descendant ? "proved" : "after" } } });
          if (late) stdout({ type: "agent_end" });
        };
        if (descendant) { stdout({ type: "agent_end" }); terminal(); afterStop(report); }
        else report();
      });
    }
  });
}
