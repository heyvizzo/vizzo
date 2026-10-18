import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunRecord } from "../shared/protocol.ts";
import { APP_ROOT } from "./paths.ts";

// RESULTS_DIR: the packaged app writes them to Application Support (its bundle is read-only).
const DIR = process.env.RESULTS_DIR ?? join(APP_ROOT, "results");

/** Chat-mode turns go to `chat-YYYY-MM-DD.jsonl`, benchmark runs (smoke:e2e) to `YYYY-MM-DD.jsonl`. */
export async function appendRun(run: RunRecord): Promise<void> {
  await mkdir(DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  await appendFile(join(DIR, `${run.config.memory ? "chat-" : ""}${day}.jsonl`), JSON.stringify(run) + "\n");
}
