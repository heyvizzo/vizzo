// The real adapters, as the default OrchestratorDeps.
import { openScribe } from "../adapters/scribe.ts";
import { openOpenRouterStt } from "../adapters/openRouterStt.ts";
import { openLocalStt, type LocalSttEngine } from "../adapters/localStt.ts";
import { openTts as openElevenTts } from "../adapters/elevenTts.ts";
import { openLocalTts } from "../adapters/localTts.ts";
import { openOpenAiTts } from "../adapters/openaiTts.ts";
import { openFishTts } from "../adapters/fishTts.ts";
import type { OpenScribe, OpenTts } from "../adapters/types.ts";
import { isLocalStt, isLocalTts, STT_OPENROUTER_MODEL } from "../../shared/config.ts";

/** ElevenLabs, OpenAI tts-1, Fish Audio Drama 3, or an on-device engine (macOS / Kokoro / Piper), by model. */
const openTts: OpenTts = (o) =>
  isLocalTts(o.model) ? openLocalTts(o.model)(o)
    : o.model === "openai_tts_1" ? openOpenAiTts(o)
    : o.model === "fish_drama_3" ? openFishTts(o)
    : openElevenTts(o);
import { generateFillers, routeTurn, solveInThread, solveTask } from "../adapters/claude.ts";
import { openHarnessThread } from "../adapters/harnessThread.ts";
import type { OrchestratorDeps } from "./types.ts";

/** Speech-to-text by model: ElevenLabs Scribe (streaming), an OpenRouter STT model (batch on release), or on-device. */
export const openStt: OpenScribe = (o) =>
  o.model && isLocalStt(o.model) ? openLocalStt(o.model.slice("local_".length) as LocalSttEngine)(o)
    : o.model && STT_OPENROUTER_MODEL[o.model] ? openOpenRouterStt(o)
    : openScribe(o);

export const realDeps: OrchestratorDeps = { openScribe: openStt, openTts, routeTurn, solveTask, generateFillers,
  openThread: openHarnessThread, solveInThread,
};
