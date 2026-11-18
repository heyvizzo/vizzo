import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function ensureDirectory(path: string): void {
  const firstCreated = mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!firstCreated) return;
  for (let dir = path; dir !== firstCreated; dir = dirname(dir)) syncDirectory(dir);
  syncDirectory(firstCreated);
  syncDirectory(dirname(firstCreated));
}

type Guard = (directory: string) => void;

function readRegular(path: string, limit = Infinity): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) throw new Error("Invalid source-control storage file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAtomic(target: string, bytes: string | Buffer, guard: Guard): void {
  const dir = dirname(target);
  guard(dir);
  ensureDirectory(dir);
  guard(dir);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    guard(dir);
    renameSync(temporary, target);
    syncDirectory(dir);
  } catch (error) {
    try { guard(dir); unlinkSync(temporary); } catch (cleanup) { if (!isMissing(cleanup)) throw cleanup; }
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
  private readonly directoryIds = new Map<string, string>();

  constructor(file = ledgerFile()) {
    const requested = resolve(file);
    this.file = join(resolvedDirectory(dirname(requested)), basename(requested));
  }

  /** Refuse substitutions anywhere on the pinned path, including during timer-driven garbage collection. */
  private guard: Guard = (directory) => {
    const parts: string[] = [];
    for (let path = directory; ; path = dirname(path)) {
      parts.unshift(path);
      if (dirname(path) === path) break;
    }
    for (const path of parts) {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      const existing = this.directoryIds.get(path);
      if (!stat) {
        if (existing) throw new Error("A source-control storage directory disappeared");
        continue;
      }
      const id = `${stat.dev}:${stat.ino}`;
      if (!stat.isDirectory() || (existing !== undefined && existing !== id)) {
        throw new Error("A source-control storage directory was substituted");
      }
      this.directoryIds.set(path, id);
    }
  };

  load(): Record<string, Project> {
    this.guard(dirname(this.file));
    let raw: string;
    try { raw = readRegular(this.file).toString("utf8"); }
    catch (error) { if (isMissing(error)) return {}; throw error; }
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== VERSION || !isRecord(value.projects) ||
        !Object.keys(value.projects).every((id) => SHA.test(id))) throw new Error("Invalid or unsupported source-control ledger");
    return value.projects as Record<string, Project>;
  }

  save(projects: Record<string, Project>): void {
    writeAtomic(this.file, JSON.stringify({ version: VERSION, projects }), this.guard);
  }

  private contentDirectory(projectId: string): string {
    if (!SHA.test(projectId)) throw new Error("Malformed source-control project id");
    return join(dirname(this.file), "ledger", projectId, "content");
  }

  assertExternal(projectId: string, directories: string[]): void {
    for (const storage of [dirname(this.file), this.contentDirectory(projectId)]) {
      this.guard(storage);
      const resolved = storage.normalize("NFC").toUpperCase();
      for (const directory of directories) {
        const path = relative(directory.normalize("NFC").toUpperCase(), resolved);
        if (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) {
          throw new Error("Source-control storage must be outside the project and Git directories");
        }
      }
    }
  }

  content(projectId: string): DiskContent {
    return new DiskContent(this.contentDirectory(projectId), this.guard);
  }
}

class DiskContent implements Content {
  private readonly dir: string;
  private readonly guard: Guard;

  constructor(dir: string, guard: Guard) {
    this.dir = dir;
    this.guard = guard;
  }

  get(blob: string): Buffer {
    if (!SHA.test(blob)) throw new Error("Malformed source-control blob id");
    const path = join(this.dir, blob);
    this.guard(this.dir);
    const bytes = readRegular(path, MAX_FILE_BYTES);
    if (hash(bytes) !== blob) throw new Error("Corrupt source-control content file");
    return bytes;
  }

  put(bytes: Buffer): string {
    if (bytes.length > MAX_FILE_BYTES) throw new Error("Source-control content exceeds the file budget");
    const blob = hash(bytes);
    const target = join(this.dir, blob);
    this.guard(this.dir);
    if (!lstatSync(target, { throwIfNoEntry: false })) writeAtomic(target, bytes, this.guard);
    else if (!this.get(blob).equals(bytes)) throw new Error("Source-control content did not match its hash");
    return blob;
  }

  /** Called only after the replacement journal is durable. Orphaned files are harmless on a crash. */
  prune(live: ReadonlySet<string>): void {
    this.guard(this.dir);
    try {
      for (const blob of readdirSync(this.dir)) {
        if (!SHA.test(blob) || live.has(blob)) continue;
        this.guard(this.dir);
        unlinkSync(join(this.dir, blob));
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

export function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
