// The real adapters, as the default OrchestratorDeps.
import { openScribe } from "../adapters/scribe.ts";
import { openRealtime } from "../adapters/openaiRealtime.ts";
import { openTts as openElevenTts } from "../adapters/elevenTts.ts";
import { openMacTts } from "../adapters/macTts.ts";
import { openOpenAiTts } from "../adapters/openaiTts.ts";
import type { OpenTts } from "../adapters/types.ts";

/** ElevenLabs, OpenAI tts-1, or on-device macOS speech, by model. */
const openTts: OpenTts = (o) => (o.model === "macos" ? openMacTts(o) : o.model === "openai_tts_1" ? openOpenAiTts(o) : openElevenTts(o));
import { generateFillers, routeWithHaiku, solveWithOpus } from "../adapters/claude.ts";
import type { OrchestratorDeps } from "./types.ts";

export const realDeps: OrchestratorDeps = { openScribe, openRealtime, openTts, routeWithHaiku, solveWithOpus, generateFillers };
