#!/usr/bin/env node
// Stand-in for a kept `claude -p` stream-json session: answers every user message on stdin (until stdin closes)
// with "<turn n>: <message>", so a test can see the context carry over. "edit <path>" first emits an Edit tool_use.
import { createInterface } from "node:readline";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let turn = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line).message.content;
  const reply = `turn ${++turn}: ${msg}`;
  const edit = /edit (\S+)/.exec(msg);
  if (edit) out({ type: "assistant", message: { model: "fake", content: [{ type: "tool_use", name: "Edit", input: { file_path: edit[1], old_string: "a", new_string: "b" } }] } });
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: reply } } });
  out({ type: "assistant", message: { model: "fake", content: [{ type: "text", text: reply }] } });
  out({ type: "result", subtype: "success", is_error: false, result: reply, usage: { input_tokens: 1, output_tokens: 1 } });
});
