// Debug view: each model call gets an id; its exact prompt (llm.prompt) and raw result (llm.response)
// go to the client under that id, so the Chat page can pair them.
import { randomUUID } from "node:crypto";
import type { LlmPrompt, LlmResponse, ServerMsg } from "../../shared/protocol.ts";

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
      onResponse: (response) => send({ type: "llm.response", turnId, ...job, callId, response }),
    };
  };
}
