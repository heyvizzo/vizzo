// The real adapters, as the default OrchestratorDeps.
import { openScribe } from "../adapters/scribe.ts";
import { openRealtime } from "../adapters/openaiRealtime.ts";
import { openTts as openElevenTts } from "../adapters/elevenTts.ts";
import { openLocalTts } from "../adapters/localTts.ts";
import { openOpenAiTts } from "../adapters/openaiTts.ts";
import type { OpenTts } from "../adapters/types.ts";
import { isLocalTts } from "../../shared/config.ts";

/** ElevenLabs, OpenAI tts-1, or an on-device engine (macOS / Kokoro / Piper), by model. */
const openTts: OpenTts = (o) =>
  isLocalTts(o.model) ? openLocalTts(o.model)(o) : o.model === "openai_tts_1" ? openOpenAiTts(o) : openElevenTts(o);
import { generateFillers, routeWithHaiku, solveWithOpus } from "../adapters/claude.ts";
import type { OrchestratorDeps } from "./types.ts";

export const realDeps: OrchestratorDeps = { openScribe, openRealtime, openTts, routeWithHaiku, solveWithOpus, generateFillers };
