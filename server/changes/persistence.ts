import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { threadsFile } from "../threads/persist.ts";
import type { Content } from "./entries.ts";
import { MAX_FILE_BYTES } from "./evidence.ts";

const VERSION = 1;
const SHA = /^[0-9a-f]{64}$/;

export function ledgerFile(): string {
  return join(dirname(threadsFile()), "ledger.json");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function ensureDirectory(path: string): void {
  const firstCreated = mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!firstCreated) return;
  for (let dir = path; dir !== firstCreated; dir = dirname(dir)) syncDirectory(dir);
  syncDirectory(firstCreated);
  syncDirectory(dirname(firstCreated));
}

function writeAtomic(target: string, bytes: string | Buffer): void {
  const dir = dirname(target);
  ensureDirectory(dir);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
    syncDirectory(dir);
  } catch (error) {
    try { unlinkSync(temporary); } catch (cleanup) { if (!isMissing(cleanup)) throw cleanup; }
    throw error;
  }
}

function resolvedDirectory(path: string): string {
  const trailing: string[] = [];
  while (!lstatSync(path, { throwIfNoEntry: false })) {
    trailing.unshift(basename(path));
    path = dirname(path);
  }
  return join(realpathSync(path), ...trailing);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export class LedgerPersistence<Project> {
  private readonly file: string;

  constructor(file = ledgerFile()) {
    this.file = resolve(file);
  }

  load(): Record<string, Project> {
    let raw: string;
    try { raw = readFileSync(this.file, "utf8"); }
    catch (error) { if (isMissing(error)) return {}; throw error; }
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== VERSION || !isRecord(value.projects) ||
        !Object.keys(value.projects).every((id) => SHA.test(id))) throw new Error("Invalid or unsupported source-control ledger");
    return value.projects as Record<string, Project>;
  }

  save(projects: Record<string, Project>): void {
    writeAtomic(this.file, JSON.stringify({ version: VERSION, projects }));
  }

  private contentDirectory(projectId: string): string {
    if (!SHA.test(projectId)) throw new Error("Malformed source-control project id");
    return join(dirname(this.file), "ledger", projectId, "content");
  }

  assertExternal(projectId: string, directories: string[]): void {
    for (const storage of [dirname(this.file), this.contentDirectory(projectId)]) {
      const resolved = resolvedDirectory(storage).normalize("NFC").toUpperCase();
      for (const directory of directories) {
        const path = relative(directory.normalize("NFC").toUpperCase(), resolved);
        if (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) {
          throw new Error("Source-control storage must be outside the project and Git directories");
        }
      }
    }
  }

  content(projectId: string): DiskContent {
    return new DiskContent(this.contentDirectory(projectId));
  }
}

class DiskContent implements Content {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  get(blob: string): Buffer {
    if (!SHA.test(blob)) throw new Error("Malformed source-control blob id");
    const path = join(this.dir, blob);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Invalid source-control content file");
    const bytes = readFileSync(path);
    if (hash(bytes) !== blob) throw new Error("Corrupt source-control content file");
    return bytes;
  }

  put(bytes: Buffer): string {
    if (bytes.length > MAX_FILE_BYTES) throw new Error("Source-control content exceeds the file budget");
    const blob = hash(bytes);
    const target = join(this.dir, blob);
    if (!lstatSync(target, { throwIfNoEntry: false })) writeAtomic(target, bytes);
    else if (!this.get(blob).equals(bytes)) throw new Error("Source-control content did not match its hash");
    return blob;
  }

  /** Called only after the replacement journal is durable. Orphaned files are harmless on a crash. */
  prune(live: ReadonlySet<string>): void {
    try {
      for (const blob of readdirSync(this.dir)) {
        if (SHA.test(blob) && !live.has(blob)) unlinkSync(join(this.dir, blob));
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

export function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
