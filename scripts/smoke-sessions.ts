// Live check of harness sessions (server/adapters/harnessThread.ts), one harness after another, with real CLIs and
// real model calls (they use each harness's own login or keys, and cost what a few short requests cost):
//   new      a session's first request works in the project folder (reads a file) and answers in the SPOKEN format
//   stop     a request stopped mid-answer leaves the session usable: the next one continues it, with its context
//   resume   with its process gone, the next request continues the harness's saved session (no text replay)
//   fork     a second session forked from it starts with its history
//   takeover the harness's own resume command, as a user would run it in a terminal, continues the same session
// Usage: npm run smoke:sessions -- [harness[=model] ...]      (default: every installed harness, a small model each)
// It works in a throwaway project folder; the sessions it makes stay in each harness's own history.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESSES, LLM_PROVIDER_LABELS, isHarness, type HarnessId, type LlmChoice } from "../shared/config.ts";
import "../server/adapters/claude.ts"; // registers the role prompts
import { harnessBin, type SessionRef } from "../server/adapters/harnesses.ts";
import { openHarnessThread } from "../server/adapters/harnessThread.ts";
import type { HarnessThread } from "../server/adapters/types.ts";
import { stopWarm } from "../server/adapters/warmPool.ts";
import { setProjectDir } from "../server/project.ts";

const MODELS: Record<HarnessId, string> = {
  "claude-code": "claude-haiku-5-5", codex: "gpt-6-luna", grok: "grok-4.7-build-fast", opencode: "cerebras/gpt-oss-120b",
  pi: "", omp: "cerebras/qwen-3.8-27b",
};
const WORD = "zebra-41";
const TIMEOUT_MS = 180_000;

const project = mkdtempSync(join(tmpdir(), "vizzo-sessions-"));
writeFileSync(join(project, "index.html"), "<!doctype html>\n<html><head><title>Lighthouse Keepers Club</title></head><body><h1>Welcome</h1></body></html>\n");
setProjectDir(project);

type Row = { step: string; ok: boolean; note: string };

/** The harness's own resume command for `ref`, with a prompt, as a user would run it (headless here, to check it). */
function takeoverCommand(h: HarnessId, ref: SessionRef, model: string, prompt: string): string[] {
  switch (h) {
    case "claude-code": return ["-p", "--resume", ref.id, prompt];
    case "codex": return ["exec", "resume", ref.id, prompt, "--skip-git-repo-check"];
    case "grok": return ["-p", prompt, "-r", ref.id];
    case "opencode": return ["run", "-s", ref.id, ...(model ? ["-m", model] : []), prompt];
    case "pi": case "omp": return ["-p", "--session", ref.file ?? ref.id, ...(model ? ["--model", model] : []), prompt];
  }
}

function runCli(bin: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // As from a terminal opened in the project folder: opencode goes by $PWD, which `cwd` alone doesn't change.
    const proc = spawn(bin, args, { cwd: project, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PWD: project } });
    let out = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), TIMEOUT_MS);
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
    proc.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e) }); });
  });
}

const short = (s: string, n = 90): string => s.replace(/\s+/g, " ").trim().slice(0, n);

async function check(h: HarnessId, model: string): Promise<Row[]> {
  const rows: Row[] = [];
  const choice: LlmChoice = { provider: h, model };
  const add = (step: string, ok: boolean, note: string): void => { rows.push({ step, ok, note }); console.log(`  ${ok ? "ok  " : "FAIL"} ${step.padEnd(9)} ${note}`); };
  const t = openHarnessThread({ role: "solver", choice, replay: () => "" });
  const ask = async (th: HarnessThread, text: string) => {
    const t0 = performance.now();
    const r = await th.send(text, undefined, TIMEOUT_MS);
    return { r, ms: Math.round(performance.now() - t0) };
  };
  let fork: HarnessThread | null = null;
  try {
    // new
    try {
      const { r, ms } = await ask(t, `Question: Remember the code word ${WORD} for later (say it back in your SPOKEN line), and tell me the <title> of index.html in this project.`);
      const read = /Lighthouse Keepers/i.test(r.text);
      // Some harnesses narrate before the answer (the turn pipeline holds that back): the SPOKEN line has to be there.
      const spoken = /SPOKEN: \S/.test(r.text);
      add("new", r.session?.mode === "new" && spoken && read,
        `${ms} ms · mode ${r.session?.mode} · session ${r.session?.id ?? "?"} · SPOKEN line: ${spoken}${/^\s*SPOKEN:/.test(r.text) ? "" : " (after narration)"} · read the file: ${read} · "${short(r.text)}"`);
    } catch (e) { add("new", false, short(String(e), 240)); return rows; }

    // stop: abort at the first text (or after 4 s), then continue
    try {
      let stopped = false;
      const stop = (): void => { if (!stopped) { stopped = true; t.abort(); } };
      const timer = setTimeout(stop, 4000);
      const t0 = performance.now();
      const err = await t.send("Question: Write a 1500-word essay about the history of lighthouses. Put all of it in the detailed answer.", () => stop(), TIMEOUT_MS).then(() => null, (e: unknown) => e as Error);
      clearTimeout(timer);
      const stopMs = Math.round(performance.now() - t0);
      const { r, ms } = await ask(t, "Question: What was the code word I gave you? Say it in the SPOKEN line.");
      add("stop", err?.name === "AbortError" && r.text.includes(WORD) && r.session?.mode === "live",
        `stopped after ${stopMs} ms (${err?.name ?? "it finished"}) · next request ${ms} ms · mode ${r.session?.mode} · knows the word: ${r.text.includes(WORD)}${r.text.includes(WORD) ? "" : ` · "${short(r.text, 300)}"`}`);
    } catch (e) { add("stop", false, short(String(e), 240)); }

    // resume: the process goes (as an eviction or a crash would take it), the next request continues the saved session
    try {
      const before = t.session?.();
      (t as unknown as { drop(): void }).drop();
      const { r, ms } = await ask(t, "Question: What was the code word I gave you? Say it in the SPOKEN line.");
      add("resume", r.session?.mode === "resumed" && r.text.includes(WORD) && r.session.id === before?.id,
        `${ms} ms · mode ${r.session?.mode}${r.session?.fallback ? ` (fallback: ${short(r.session.fallback, 120)})` : ""} · same session: ${r.session?.id === before?.id} · knows the word: ${r.text.includes(WORD)}`);
    } catch (e) { add("resume", false, short(String(e), 240)); }

    // fork
    try {
      fork = openHarnessThread({ role: "solver", choice, forkOf: t, replay: () => "" });
      const { r, ms } = await ask(fork, "Question: What was the code word I gave you? Say it in the SPOKEN line.");
      add("fork", r.session?.mode === "forked" && r.text.includes(WORD) && !!r.session.id && r.session.id !== t.session?.()?.id,
        `${ms} ms · mode ${r.session?.mode}${r.session?.fallback ? ` (fallback: ${short(r.session.fallback, 120)})` : ""} · its own session: ${r.session?.id ?? "?"} · knows the word: ${r.text.includes(WORD)}`);
    } catch (e) { add("fork", false, short(String(e), 240)); }

    // takeover: Vizzo lets go of the session, then the harness's own resume command continues it
    try {
      const ref = t.session?.();
      t.close();
      fork?.close();
      if (!ref) { add("takeover", false, "the session has no id"); return rows; }
      await new Promise((r) => setTimeout(r, 2000)); // a person takes longer than this to open a terminal
      const args = takeoverCommand(h, ref, model, "What was the code word I gave you earlier in this conversation? Reply with just the word.");
      const t0 = performance.now();
      const { code, out } = await runCli(harnessBin(h)!, args);
      const shown = args.map((a) => (a.length > 60 ? '"…"' : a)).join(" ");
      add("takeover", out.includes(WORD), `${harnessBin(h)?.split("/").pop()} ${shown} → exit ${code} after ${Math.round(performance.now() - t0)} ms · knows the word: ${out.includes(WORD)}${out.includes(WORD) ? "" : ` · "${short(out, 200)}"`}`);
    } catch (e) { add("takeover", false, short(String(e), 240)); }
  } finally {
    try { fork?.close(); } catch { /* ignore */ }
    try { t.close(); } catch { /* ignore */ }
  }
  return rows;
}

const wanted = process.argv.slice(2).map((a) => a.split("="));
const list: [HarnessId, string][] = (wanted.length ? wanted.map(([h, m]) => [h, m] as [string, string | undefined]) : HARNESSES.map((h) => [h, undefined] as [string, string | undefined]))
  .filter(([h]) => isHarness(h!)).map(([h, m]) => [h as HarnessId, m ?? MODELS[h as HarnessId]]);

console.log(`project folder: ${project}`);
const summary: string[] = [];
for (const [h, model] of list) {
  console.log(`\n${LLM_PROVIDER_LABELS[h]} · ${model || "(default model)"}`);
  if (!harnessBin(h)) { console.log("  not installed"); summary.push(`${h}: not installed`); continue; }
  const rows = await check(h, model);
  summary.push(`${h}: ${rows.map((r) => `${r.step} ${r.ok ? "ok" : "FAIL"}`).join(", ")}`);
}
stopWarm();
console.log(`\n${summary.join("\n")}`);
process.exit(summary.some((s) => s.includes("FAIL")) ? 1 : 0);
