#!/usr/bin/env node
// The unsubscribe response precedes thread/closed, as it does in the native app-server.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
let next = 0;
const threads = new Map();
const out = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const log = (value) => { if (process.env.FIXTURE_CODEX_LOG) appendFileSync(process.env.FIXTURE_CODEX_LOG, JSON.stringify(value) + "\n"); };
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (!m.id) return;
  log(m);
  const reply = (result) => out({ id: m.id, result });
  if (m.method === "initialize") return reply({});
  if (m.method === "config/read") return reply({ config: {} });
  if (["thread/start", "thread/resume", "thread/fork"].includes(m.method)) {
    const id = m.method === "thread/resume" ? m.params.threadId : `fake-codex-${++next}`;
    threads.set(id, m.params.config);
    return reply({ thread: { id } });
  }
  if (m.method === "turn/start") {
    reply({ turn: { id: "turn-1" } });
    out({ method: "item/agentMessage/delta", params: { threadId: m.params.threadId, delta: "SPOKEN: Done." } });
    return out({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { id: "turn-1", status: "completed" } } });
  }
  if (m.method === "thread/unsubscribe") {
    const id = m.params.threadId;
    if (!threads.has(id)) return reply({ status: "notLoaded" });
    reply({ status: "unsubscribed" });
    if (threads.get(id)?.thread_unload_delay_secs === 0) setTimeout(() => {
      threads.delete(id);
      log({ method: "thread/closed", threadId: id });
      out({ method: "thread/closed", params: { threadId: id } });
    }, 150);
    return;
  }
  reply({});
});
