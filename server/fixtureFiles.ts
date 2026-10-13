import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// ── fixtures/utterances (GET /api/fixtures, for the latency lab's replay picker) ──
const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures", "utterances");
/** Only plain `Uxx.wav` / `Uxx.cursor.json` / `Uxx.labels.json` names: no separators or dots in the id, so no traversal. */
const FIXTURE_NAME = /^[A-Za-z0-9_-]+\.(wav|cursor\.json|labels\.json)$/;

export async function listFixtureFiles(): Promise<string[]> {
  try { return (await readdir(FIXTURE_DIR)).filter((f) => FIXTURE_NAME.test(f)).sort(); } catch { return []; }
}

export async function readFixtureFile(name: string): Promise<{ data: Buffer; type: string } | null> {
  if (!FIXTURE_NAME.test(name)) return null;
  try {
    const data = await readFile(join(FIXTURE_DIR, name));
    return { data, type: name.endsWith(".wav") ? "audio/wav" : "application/json" };
  } catch {
    return null;
  }
}
