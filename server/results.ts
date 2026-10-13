import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunRecord } from "../shared/protocol.ts";

const DIR = join(import.meta.dirname, "..", "results");

export async function appendRun(run: RunRecord): Promise<void> {
  await mkdir(DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  await appendFile(join(DIR, `${day}.jsonl`), JSON.stringify(run) + "\n");
}

export async function loadRuns(): Promise<RunRecord[]> {
  let files: string[];
  try { files = (await readdir(DIR)).filter((f) => f.endsWith(".jsonl")).sort(); } catch { return []; }
  const runs: RunRecord[] = [];
  for (const f of files) {
    for (const line of (await readFile(join(DIR, f), "utf8")).split("\n")) {
      if (line.trim()) try { runs.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
  }
  return runs;
}
