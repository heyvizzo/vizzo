// Per-connection cache (see ConnectionCache in orchestrators/types.ts).
import type { ConnectionCache } from "./orchestrators/types.ts";

export class ConnectionState implements ConnectionCache {
  private entries = new Map<string, { value: unknown; dispose?: (v: unknown) => void }>();

  get<T>(key: string): T | undefined {
    return this.entries.get(key)?.value as T | undefined;
  }

  set<T>(key: string, value: T, dispose?: (value: T) => void): void {
    this.delete(key);
    this.entries.set(key, { value, dispose: dispose as ((v: unknown) => void) | undefined });
  }

  delete(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    try { e.dispose?.(e.value); } catch (err) { console.error(`[connection] dispose ${key} failed`, err); }
  }

  disposeAll(): void {
    for (const key of [...this.entries.keys()]) this.delete(key);
  }
}
