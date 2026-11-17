import type { HarnessId } from "./config.ts";

/** The native session behind a panel. Absent id: its harness is still starting. */
export interface HarnessSessionInfo {
  provider: HarnessId;
  id?: string;
  /** Includes the session's working directory and shell-quoted arguments. */
  resumeCommand?: string;
}
