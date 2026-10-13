// The real adapters, as the default OrchestratorDeps.
import { openScribe } from "../adapters/scribe.ts";
import { openRealtime } from "../adapters/openaiRealtime.ts";
import { openTts as openElevenTts } from "../adapters/elevenTts.ts";
import { openMacTts } from "../adapters/macTts.ts";
import type { OpenTts } from "../adapters/types.ts";

/** ElevenLabs, or on-device macOS speech for model "macos". */
const openTts: OpenTts = (o) => (o.model === "macos" ? openMacTts(o) : openElevenTts(o));
import { generateFillers, routeWithHaiku, solveWithOpus } from "../adapters/claude.ts";
import type { OrchestratorDeps } from "./types.ts";

export const realDeps: OrchestratorDeps = { openScribe, openRealtime, openTts, routeWithHaiku, solveWithOpus, generateFillers };
