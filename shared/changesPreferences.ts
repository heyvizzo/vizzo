import { TASK_TIMEOUT_MAX, type LlmTier } from "./config.ts";

const DEFAULT_COMMIT_MESSAGE_TIMEOUT_SECONDS: Record<LlmTier, number> = { fast: 15, smart: 60 };
export const COMMIT_MESSAGE_TIMEOUT_MAX_SECONDS = TASK_TIMEOUT_MAX * 60;

export function validCommitMessageTimeout(seconds: unknown): seconds is number {
  return typeof seconds === "number" && Number.isInteger(seconds) && seconds >= 1 && seconds <= COMMIT_MESSAGE_TIMEOUT_MAX_SECONDS;
}

export interface ChangesPreferences {
  gitSourceControl: boolean;
  commitMessageTier: LlmTier;
  commitMessageTimeoutSeconds: Record<LlmTier, number>;
  autoCommitMessage: boolean;
}

export function changesPreferences(saved: unknown): ChangesPreferences {
  const source = saved && typeof saved === "object" ? saved as Partial<ChangesPreferences> : {};
  const { fast, smart } = source.commitMessageTimeoutSeconds ?? {};
  return {
    gitSourceControl: source.gitSourceControl !== false,
    commitMessageTier: source.commitMessageTier === "smart" ? "smart" : "fast",
    commitMessageTimeoutSeconds: {
      fast: validCommitMessageTimeout(fast) ? fast : DEFAULT_COMMIT_MESSAGE_TIMEOUT_SECONDS.fast,
      smart: validCommitMessageTimeout(smart) ? smart : DEFAULT_COMMIT_MESSAGE_TIMEOUT_SECONDS.smart,
    },
    autoCommitMessage: source.autoCommitMessage !== false,
  };
}
