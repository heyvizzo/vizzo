// Approach C (hybrid): approach A plus Scribe in parallel for word timestamps → pointing context.
// See realtime.ts for the shared implementation (ARCHITECTURE §7).
import { realDeps } from "./deps.ts";
import { createRealtimeLikeOrchestrator } from "./realtime.ts";
import type { Orchestrator, OrchestratorDeps } from "./types.ts";

export const createHybridOrchestrator = (deps: OrchestratorDeps): Orchestrator => createRealtimeLikeOrchestrator(deps, true);
export const hybridOrchestrator: Orchestrator = createHybridOrchestrator(realDeps);
