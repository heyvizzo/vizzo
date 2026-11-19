import type { LlmTier } from "./config.ts";

export interface ChangesPreferences {
  gitSourceControl: boolean;
  commitMessageTier: LlmTier;
  autoCommitMessage: boolean;
}

export function changesPreferences(saved: unknown): ChangesPreferences {
  const source = saved && typeof saved === "object" ? saved as Partial<ChangesPreferences> : {};
  return {
    gitSourceControl: source.gitSourceControl === true,
    commitMessageTier: source.commitMessageTier === "smart" ? "smart" : "fast",
    autoCommitMessage: source.autoCommitMessage !== false,
  };
}
