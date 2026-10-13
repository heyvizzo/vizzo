// The real adapters, as the default OrchestratorDeps.
import { openScribe } from "../adapters/scribe.ts";
import { openRealtime } from "../adapters/openaiRealtime.ts";
import { openTts } from "../adapters/elevenTts.ts";
import { routeWithHaiku, solveWithOpus } from "../adapters/claude.ts";
import type { OrchestratorDeps } from "./types.ts";

export const realDeps: OrchestratorDeps = { openScribe, openRealtime, openTts, routeWithHaiku, solveWithOpus };
