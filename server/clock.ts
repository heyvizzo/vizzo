import { performance } from "node:perf_hooks";
import type { MarkName } from "../shared/marks.ts";

/** Server clock used for every server-side mark. */
export const serverNow = (): number => performance.timeOrigin + performance.now();

export type Mark = (name: MarkName, meta?: Record<string, unknown>) => void;
