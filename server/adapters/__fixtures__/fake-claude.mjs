#!/usr/bin/env node
// Stand-in for `claude -p --input-format stream-json --output-format stream-json`: waits for one user
// message on stdin, streams a reply as partial-message events, ends with a result event, exits.
// Reply: FAKE_CLAUDE_REPLY (default: echoes the system prompt's first word + the message).
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const sys = args[args.indexOf("--system-prompt") + 1] ?? "";
const model = args[args.indexOf("--model") + 1] ?? "fake";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const rl = createInterface({ input: process.stdin });
rl.once("line", (line) => {
  const msg = JSON.parse(line).message.content;
  const reply = process.env.FAKE_CLAUDE_REPLY ?? `${sys.split(/\s+/)[0]}: ${msg}`;
  out({ type: "system", subtype: "init", model });
  out({ type: "stream_event", event: { type: "message_start" } });
  for (const part of reply.match(/.{1,8}/gs) ?? []) out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: part } } });
  out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } });
  out({ type: "assistant", message: { model, content: [{ type: "text", text: reply }] } });
  out({ type: "result", subtype: "success", is_error: false, result: reply, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.0001, duration_ms: 5, duration_api_ms: 4 });
  rl.close();
});
