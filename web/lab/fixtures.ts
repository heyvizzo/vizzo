// Replay fixtures for the latency lab: Uxx.wav + optional Uxx.cursor.json + Uxx.labels.json (ARCHITECTURE §6.1).
// Parsing reuses the cursor lab's session loader.
import type { CursorSample } from "../../shared/protocol.ts";
import { sessionsFromFiles, type LoadedFile } from "../cursor/session.ts";

export interface Fixture {
  id: string;
  transcript: string;
  samples: CursorSample[];
  pointingWords: number;
  labeled: number;
  /** WAV bytes, or a loader for server-listed fixtures (fetched on first use). */
  wav: Blob | null;
  loadWav?: () => Promise<Blob>;
  origin: "files" | "server" | "fake";
}

const ID_RE = /^(.+?)\.(cursor\.json|labels\.json|wav)$/i;
const idOf = (name: string): string | null => ID_RE.exec(name.split("/").pop()!)?.[1] ?? null;

/** Group loaded files into fixtures. A WAV without a cursor file is still a valid (cursor-less) fixture. */
export function fixturesFromFiles(files: readonly LoadedFile[], origin: Fixture["origin"] = "files"): { fixtures: Fixture[]; errors: string[] } {
  const withCursor = new Set(files.filter((f) => /\.cursor\.json$/i.test(f.name)).map((f) => idOf(f.name)));
  const { sessions, errors } = sessionsFromFiles(files.filter((f) => withCursor.has(idOf(f.name))));
  const fixtures: Fixture[] = sessions.map((s) => ({
    id: s.id, transcript: s.transcript, samples: s.samples, pointingWords: s.labels.length,
    labeled: s.labels.filter((l) => l.target).length, wav: s.wav ?? null, origin,
  }));
  for (const f of files) {
    const id = idOf(f.name);
    if (!id || withCursor.has(id) || !/\.wav$/i.test(f.name)) continue;
    fixtures.push({ id, transcript: "", samples: [], pointingWords: 0, labeled: 0, wav: f.blob ?? null, origin });
  }
  for (const f of files) if (!idOf(f.name)) errors.push(`${f.name}: unrecognized file name`);
  for (const fx of fixtures) if (!fx.wav) errors.push(`${fx.id}: no ${fx.id}.wav (cannot replay)`);
  fixtures.sort((a, b) => a.id.localeCompare(b.id));
  return { fixtures, errors };
}

export async function filesFromInput(list: FileList | null): Promise<LoadedFile[]> {
  return Promise.all([...(list ?? [])].map(async (f) =>
    f.name.toLowerCase().endsWith(".wav") ? { name: f.name, blob: f } : { name: f.name, text: await f.text() }));
}

/** Fixtures in fixtures/utterances/ via GET /api/fixtures (WAVs fetched lazily). */
export async function loadServerFixtures(): Promise<{ fixtures: Fixture[]; errors: string[] }> {
  const res = await fetch("/api/fixtures");
  if (!res.ok) throw new Error(`/api/fixtures: HTTP ${res.status}`);
  const names = (await res.json()) as string[];
  const url = (n: string) => `/api/fixtures/${encodeURIComponent(n)}`;
  const files: LoadedFile[] = await Promise.all(names.map(async (name) =>
    name.toLowerCase().endsWith(".wav")
      ? { name, blob: new Blob() } // placeholder; replaced by a lazy loader below
      : { name, text: await (await fetch(url(name))).text() }));
  const { fixtures, errors } = fixturesFromFiles(files, "server");
  for (const fx of fixtures) {
    const wavName = names.find((n) => n === `${fx.id}.wav`);
    fx.wav = null;
    if (wavName) {
      fx.loadWav = async () => {
        const r = await fetch(url(wavName));
        if (!r.ok) throw new Error(`${wavName}: HTTP ${r.status}`);
        return r.blob();
      };
    }
  }
  return { fixtures, errors: errors.filter((e) => !/cannot replay/.test(e)) };
}

export async function fixtureWav(fx: Fixture): Promise<ArrayBuffer> {
  if (!fx.wav && fx.loadWav) fx.wav = await fx.loadWav();
  if (!fx.wav) throw new Error(`${fx.id}: no WAV`);
  return fx.wav.arrayBuffer();
}
