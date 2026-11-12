import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { InstructionsSnapshot, StoredInstructions } from "../shared/instructions.ts";

/** Symlinks and relative paths to the same folder share instructions. */
export function instructionProjectKey(dir: string): string {
  try { return realpathSync(dir); } catch { return resolve(dir); }
}

export function cleanInstructions(input: unknown): StoredInstructions {
  const source = input && typeof input === "object" ? input as Partial<StoredInstructions> : {};
  const projects = source.projects && typeof source.projects === "object" ? source.projects : {};
  return {
    global: typeof source.global === "string" ? source.global : "",
    projects: Object.fromEntries(Object.entries(projects).filter(([key, value]) => isAbsolute(key) && typeof value === "string")),
  };
}

/** Reads only the instruction fields; never opens the encrypted API keys. */
export function readInstructions(file: string): StoredInstructions {
  try { return cleanInstructions(JSON.parse(readFileSync(file, "utf8"))?.instructions); }
  catch { return cleanInstructions(null); }
}

export function instructionSnapshot(input: unknown, dir: string | null): InstructionsSnapshot {
  const stored = cleanInstructions(input);
  const projectDir = dir ? instructionProjectKey(dir) : null;
  return { global: stored.global, project: projectDir ? stored.projects[projectDir] ?? "" : "", projectDir };
}

/** Merge one field so a late save for a previous folder can never overwrite the new folder's instructions. */
export function editInstructions(input: unknown, edit: unknown): StoredInstructions {
  const stored = cleanInstructions(input);
  if (!edit || typeof edit !== "object") throw new Error("Invalid instruction edit.");
  const value = edit as Record<string, unknown>;
  if (typeof value.text !== "string") throw new Error("Instructions must be text.");
  if (value.scope === "global") return { ...stored, global: value.text };
  if (value.scope !== "project" || typeof value.projectDir !== "string" || !isAbsolute(value.projectDir)) {
    throw new Error("Choose a project folder before saving its instructions.");
  }
  const key = instructionProjectKey(value.projectDir);
  if (value.text.trim()) stored.projects[key] = value.text;
  else delete stored.projects[key];
  return stored;
}
