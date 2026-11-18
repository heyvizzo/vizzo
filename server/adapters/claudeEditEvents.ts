export interface ClaudeEditBatch {
  sessionId: string;
  toolCallId: string;
  changes: { path: string; from: string | null; to: string | null }[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Claude Code 2.1.327 normalizes line endings in Edit and overwrite Write results. A Write create
 * supplies both explicit prior absence and the resulting text. MultiEdit and NotebookEdit yield no evidence.
 */
export class ClaudeEditEvents {
  /** The requested path, or null once a matching completion was seen or the tool identity conflicted. */
  private readonly writes = new Map<string, string | null>();

  accept(event: Record<string, unknown>): ClaudeEditBatch[] {
    const sessionId = event.session_id;
    if (typeof sessionId !== "string" || !sessionId) return [];
    const message = record(event.message);
    const content = message?.content;
    if (!Array.isArray(content)) return [];

    if (event.type === "assistant" && message?.role === "assistant") {
      for (const value of content) {
        const call = record(value);
        if (call?.type !== "tool_use" || call.name !== "Write" || typeof call.id !== "string" || !call.id) continue;
        const input = record(call.input);
        const path = input?.file_path;
        if (typeof path !== "string" || !path || path.includes("\0") || typeof input?.content !== "string") continue;
        const key = JSON.stringify([sessionId, call.id]);
        const knownPath = this.writes.get(key);
        this.writes.set(key, knownPath === undefined || knownPath === path ? path : null);
      }
      return [];
    }

    // The structured attachment belongs to the single tool result in the user envelope.
    if (event.type !== "user" || message?.role !== "user" || content.length !== 1) return [];
    const reply = record(content[0]);
    if (reply?.type !== "tool_result" || typeof reply.tool_use_id !== "string" || !reply.tool_use_id) return [];
    const toolCallId = reply.tool_use_id;
    const key = JSON.stringify([sessionId, toolCallId]);
    const path = this.writes.get(key);
    if (path === undefined || path === null) return [];
    this.writes.set(key, null);
    if ((reply.is_error !== undefined && reply.is_error !== false) || typeof reply.content !== "string" || !reply.content) return [];

    const result = record(event.tool_use_result);
    if (result?.type !== "create" || result.filePath !== path || result.originalFile !== null
      || result.userModified !== false || !Array.isArray(result.structuredPatch) || result.structuredPatch.length !== 0) return [];
    const to = result.content;
    if (typeof to !== "string" || Buffer.from(to, "utf8").toString("utf8") !== to) return [];
    return [{ sessionId, toolCallId, changes: [{ path, from: null, to }] }];
  }
}
