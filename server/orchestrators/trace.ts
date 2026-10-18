// Debug view: each model call gets an id; its exact prompt (llm.prompt) and raw result (llm.response)
// go to the client under that id, so the Chat page can pair them.
import { randomUUID } from "node:crypto";
import type { LlmPrompt, LlmResponse, ServerMsg } from "../../shared/protocol.ts";
import { callCost } from "../cost.ts";

/** Attach what the call cost (from its usage). */
export function priced(r: LlmResponse): LlmResponse {
  if (r.error || !r.usage) return r;
  const usd = callCost(r.target, r.usage, r.model);
  // Calls through a CLI's own login (claude -p, Codex, Grok) run on a subscription: nothing billed per call, show what was saved.
  return r.billing === "subscription" ? { ...r, costUsd: 0, savedUsd: usd } : { ...r, costUsd: usd };
}

export interface CallTrace {
  callId: string;
  onPrompt: (prompt: LlmPrompt) => void;
  onResponse: (response: LlmResponse) => void;
}

/** A factory of per-call traces for one turn (or, with jobId, one background job). */
export function tracer(send: (m: ServerMsg) => void, turnId: string, jobId?: string): () => CallTrace {
  const job = jobId ? { jobId } : {};
  return () => {
    const callId = randomUUID();
    return {
      callId,
      onPrompt: (prompt) => send({ type: "llm.prompt", turnId, ...job, callId, prompt }),
      onResponse: (response) => send({ type: "llm.response", turnId, ...job, callId, response: priced(response) }),
    };
  };
}
