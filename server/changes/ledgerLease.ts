import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, type BigIntStats } from "node:fs";

const LEASE_REFUSED = "LEDGER_LEASE_REFUSED";
const BUSY = 75;

export class LedgerLeaseRefusedError extends Error {
  readonly code = LEASE_REFUSED;
}

export function isLedgerLeaseRefused(error: unknown): error is LedgerLeaseRefusedError {
  return error instanceof Error && "code" in error && error.code === LEASE_REFUSED;
}

function privateFile(stat: BigIntStats): boolean {
  return stat.isFile() && stat.nlink === 1n && Number(stat.uid) === process.getuid?.() && (stat.mode & 0o077n) === 0n;
}

function lockDescriptor(fd: number): void {
  const options: SpawnSyncOptions = { stdio: ["ignore", "ignore", "ignore", fd], timeout: 5_000, killSignal: "SIGKILL" };
  let result;
  // Both utilities lock the inherited open file description. Vizzo keeps its descriptor after the utility exits.
  if (process.platform === "darwin") {
    result = spawnSync("/usr/bin/lockf", ["-s", "-t", "0", "3"], options);
  } else if (process.platform === "linux") {
    const command = existsSync("/usr/bin/flock") ? "/usr/bin/flock" : "/bin/flock";
    result = spawnSync(command, ["--exclusive", "--nonblock", "--conflict-exit-code", String(BUSY), "3"], options);
  } else {
    throw new LedgerLeaseRefusedError("Source-control ledger locking is unavailable on this platform");
  }
  if (result.status === BUSY) throw new LedgerLeaseRefusedError("Another Vizzo process owns the source-control ledger");
  if (result.status !== 0) throw new LedgerLeaseRefusedError("Could not acquire the source-control ledger lock", { cause: result.error });
}

/** Keep the sibling file across restarts so every actor locks the same inode. */
export class LedgerLease {
  private readonly journal: string;
  private readonly path: string;
  private readonly fd: number;

  private constructor(journal: string, path: string, fd: number) {
    this.journal = journal;
    this.path = path;
    this.fd = fd;
  }

  static acquire(journal: string): LedgerLease {
    const path = `${journal}.lock`;
    const existing = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (existing && !privateFile(existing)) throw new Error("The source-control ledger lock is not a private regular file");
    const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const lease = new LedgerLease(journal, path, fd);
      lease.assertHeld();
      lockDescriptor(fd);
      lease.assertHeld();
      return lease;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  /** Detect a disappearing, relinked or substituted lock before using the ledger. */
  assertHeld(): void {
    const opened = fstatSync(this.fd, { bigint: true });
    const current = lstatSync(this.path, { bigint: true, throwIfNoEntry: false });
    if (!privateFile(opened) || !current || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error("The source-control ledger lock was substituted or is no longer private");
    }
    const journal = lstatSync(this.journal, { bigint: true, throwIfNoEntry: false });
    if (journal && (!journal.isFile() || journal.nlink !== 1n)) {
      throw new Error("The source-control ledger must be a regular file with one link");
    }
  }

  /** Used during failed initialization. The worker also closes tracked descriptors on exit. */
  close(): void {
    closeSync(this.fd);
  }
}
