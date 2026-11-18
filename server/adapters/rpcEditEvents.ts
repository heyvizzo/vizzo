import { isAbsolute } from "node:path";

type RpcEditHarness = "pi" | "omp";

export interface RpcEditEvent {
  toolCallId: string;
  /**
   * A successful tool call's complete batch. Paths are absolute paths reported by the harness.
   * The caller must apply the evidence only to regular files inside the project. OhMyPi reports referent
   * bytes under a symlink's path, so the caller must reject symlink entries and paths through symlink directories.
   */
  changes: { path: string; from: string; to: string | null }[];
}

/** Returns a reason to disable per-thread commits for a harness with no exact RPC edit evidence. */
export function rpcEditAttributionUnavailableReason(harness: RpcEditHarness): string | undefined {
  if (harness === "pi") return "Pi does not report exact before-and-after file content or patches.";
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

// Unicode mode matches lone surrogates without matching either half of a valid pair.
const exactText = (value: unknown): value is string => typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value);

function ompFileChange(value: unknown): RpcEditEvent["changes"][number] | undefined {
  const details = record(value);
  if (!details) return;
  const { path, oldText, newText, op } = details;
  if (!exactText(path) || !isAbsolute(path) || path.includes("\0") || !exactText(oldText)) return;

  // OMP can overwrite a move destination and reports only the source's old bytes.
  if ("move" in details || "sourcePath" in details) return;
  if (op === "delete" && !("newText" in details)) return { path, from: oldText, to: null };
  if (op === "update" && exactText(newText)) return { path, from: oldText, to: newText };
}

function ompFileChanges(value: unknown): RpcEditEvent["changes"] | undefined {
  const details = record(record(value)?.details);
  if (!details || "move" in details || "sourcePath" in details) return;
  const files = "perFileResults" in details ? details.perFileResults : [details];
  if (!Array.isArray(files) || files.length === 0) return;

  const changes: RpcEditEvent["changes"] = [];
  const paths = new Set<string>();
  for (const file of files) {
    const change = ompFileChange(file);
    if (!change || paths.has(change.path)) return;
    paths.add(change.path);
    changes.push(change);
  }
  return changes;
}

/**
 * Create one parser per execution and RPC connection. A completion needs a start on that connection.
 * The ledger deduplicates whole tool calls across reconnects using the execution, session and tool call IDs.
 * Pi's display diff and both harnesses' write acknowledgments lack the exact evidence required by the ledger.
 */
export function createRpcEditEventParser(harness: RpcEditHarness): (event: unknown) => RpcEditEvent | undefined {
  if (harness === "pi") return () => undefined;

  const calls = new Map<string, "started" | "completed">();
  return (value) => {
    const event = record(value);
    if (event?.toolName !== "edit") return;
    const { toolCallId } = event;
    if (typeof toolCallId !== "string" || !toolCallId) return;

    if (event.type === "tool_execution_start") {
      const input = record(event.args)?.input;
      if (!calls.has(toolCallId) && typeof input === "string" && input) calls.set(toolCallId, "started");
      return;
    }
    if (event.type !== "tool_execution_end" || calls.get(toolCallId) !== "started") return;
    calls.set(toolCallId, "completed");
    if (event.isError !== false) return;

    const changes = ompFileChanges(event.result);
    if (changes) return { toolCallId, changes };
  };
}
