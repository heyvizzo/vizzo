import type { ThreadDeleteChoice, ThreadDeletePreview } from "../../shared/threads.ts";
import { changesService, type ChangesService } from "../changes/changesService.ts";
import type { ThreadDeleteTarget, ThreadDeletePreview as DeleteReceipt } from "../changes/deleteFlows.ts";
import { threadMessageContext } from "../changes/messageContext.ts";
import { discoverLedgerProject } from "../changes/project.ts";
import { threadStore, type ThreadRecord, type ThreadStore } from "./store.ts";

type DeleteService = Pick<ChangesService, "previewThreadDeletes" | "deleteThreads">;
type RecoveryService = Pick<ChangesService, "restore" | "pendingThreadDeletes" | "completeThreadDeletes">;

const LOCAL_REQUIRED = "Source control requires the local Vizzo window.";
const WORKING = "The thread is still working. Its changes will be kept uncommitted.";

export function threadDeleteTarget(record: ThreadRecord, mode: ThreadDeleteChoice["mode"] = "keep"): ThreadDeleteTarget {
  const { info, handle, resume } = record;
  const folder = record.projectFolder !== undefined ? record.projectFolder : handle?.spec?.project ?? resume?.spec.project ?? null;
  return {
    threadId: info.threadId, title: info.title, folder, mode, working: record.run?.working === true || info.state === "running",
    requests: info.messages.filter(({ role }) => role === "user").map(({ text }) => text), summary: info.summary,
    messageContext: threadMessageContext(info.messages),
    interruptedExecutionId: info.interrupted ? record.activeRequest?.executionId : undefined,
  };
}

/** Older clients outside the local server can still remove threads that cannot own source-control work. */
function legacyPreflight(targets: readonly ThreadDeleteTarget[]): DeleteReceipt[] {
  const folders = new Set(targets.flatMap(({ folder }) => folder ? [folder] : []));
  for (const folder of folders) {
    if (discoverLedgerProject(folder).reason !== "The project folder is not in a Git worktree") throw new Error(LOCAL_REQUIRED);
  }
  return targets.map(({ threadId, working }) => ({
    threadId, state: working ? "working" : "none", defaultMode: "keep", owned: false, willCommit: false,
    ...(working ? { reason: WORKING } : {}),
  }));
}

export async function previewThreadDeletes(
  store: ThreadStore, threadIds: readonly string[], changes?: DeleteService, isEnabled: () => boolean = () => true,
): Promise<ThreadDeletePreview[]> {
  const generic = (): ThreadDeletePreview[] => threadIds.map((threadId) => {
    const record = store.get(threadId);
    return { threadId, state: record && threadDeleteTarget(record).working ? "working" : "none", defaultMode: "keep" };
  });
  if (!isEnabled()) return generic();
  if (!store.sourceControlAvailable) changes = undefined;
  const targets = threadIds.flatMap((id) => {
    const record = store.get(id);
    return record ? [threadDeleteTarget(record)] : [];
  });
  let receipts: DeleteReceipt[];
  try {
    receipts = changes && targets.some(({ folder }) => folder) ? await changes.previewThreadDeletes(targets) : legacyPreflight(targets);
  } catch (error) {
    if (!isEnabled()) return generic();
    throw error;
  }
  if (!isEnabled()) return generic();
  for (const receipt of receipts) applyCompletion(store, receipt);
  const byId = new Map(receipts.map(({ threadId, state, reason, defaultMode, owned, willCommit }) =>
    [threadId, { threadId, state, reason, defaultMode, owned, willCommit }]));
  return threadIds.map((threadId) => byId.get(threadId) ?? { threadId, state: "none", defaultMode: "keep" });
}

export async function deleteThreads(
  store: ThreadStore, choices: readonly ThreadDeleteChoice[] | undefined, reset: boolean, changes?: DeleteService, verifyCommit?: () => void,
): Promise<void> {
  if (!store.sourceControlAvailable) changes = undefined;
  const modes = new Map(choices?.map(({ threadId, mode }) => [threadId, mode]));
  const ids = reset && choices === undefined ? store.list().map(({ threadId }) => threadId) : [...modes.keys()];
  const expected = new Set(ids);
  const verifyReset = () => {
    const current = store.list();
    if (current.length !== expected.size || current.some(({ threadId }) => !expected.has(threadId))) {
      throw new Error("The thread list changed. Review it before starting a new conversation.");
    }
  };
  verifyCommit?.();
  if (reset) verifyReset();
  const targets = ids.flatMap((threadId) => {
    const record = store.get(threadId);
    return record ? [threadDeleteTarget(record, modes.get(threadId))] : [];
  });
  const release = store.beginDeletion(targets.map(({ threadId }) => threadId), reset);
  const prepare = () => {
    if (!reset) return;
    verifyReset();
    store.prepareReset();
  };
  try {
    if (changes && targets.some(({ folder }) => folder)) {
      await changes.deleteThreads(targets, {
        prepare,
        verifyCommit,
        stop: (threadId) => store.stopForDeletion(threadId),
        remove: (threadIds) => store.removeDurably(threadIds),
      });
    } else {
      const receipts = legacyPreflight(targets);
      prepare();
      for (const { threadId, state } of receipts) if (state === "working") store.stopForDeletion(threadId);
      store.removeDurably(targets.map(({ threadId }) => threadId));
    }
    if (reset) store.clearConversation();
  } finally { release(); }
}

export function savedNativeSession(record: ThreadRecord): string | undefined {
  return record.handle?.session?.()?.id ?? record.resume?.ref?.id;
}

function applyCompletion(store: ThreadStore, receipt: DeleteReceipt): void {
  if (receipt.owned === undefined) return; // An unavailable scan cannot clear a saved incomplete status.
  const record = store.get(receipt.threadId);
  if (!record) return;
  const incomplete = !!receipt.incompleteReason;
  const sessionId = savedNativeSession(record);
  const canContinue = !!(receipt.continuesExecutionId && sessionId && receipt.continuationSessionId === sessionId);
  const { info } = record;
  if (Boolean(info.incomplete) === incomplete && info.incompleteReason === receipt.incompleteReason && Boolean(info.canContinue) === canContinue) return;
  store.update(receipt.threadId, (thread) => {
    thread.incomplete = incomplete || undefined;
    thread.incompleteReason = receipt.incompleteReason;
    thread.canContinue = canContinue || undefined;
  });
}

export function refreshThreadCompletion(store: ThreadStore, threadId: string): Promise<void> {
  return refreshThreadCompletions(store, [threadId], changesService());
}

async function refreshThreadCompletions(store: ThreadStore, ids: readonly string[], service: DeleteService): Promise<void> {
  if (!store.sourceControlAvailable) return;
  const byFolder = new Map<string, ThreadDeleteTarget[]>();
  for (const id of ids) {
    const record = store.get(id);
    if (!record || store.blocksRun(id)) continue;
    const target = threadDeleteTarget(record);
    if (!target.folder) continue;
    const targets = byFolder.get(target.folder) ?? [];
    targets.push(target);
    byFolder.set(target.folder, targets);
  }
  await Promise.all([...byFolder.values()].map(async (targets) => {
    try {
      for (const receipt of await service.previewThreadDeletes(targets)) {
        if (!store.blocksRun(receipt.threadId)) applyCompletion(store, receipt);
      }
    } catch (error) { console.warn("[threads] could not refresh incomplete work", error); }
  }));
}

/** A reviewed scan can show that previously incomplete changes were committed or overwritten. */
export function monitorThreadCompletion(service = changesService(), store = threadStore()): () => void {
  void refreshThreadCompletions(store, store.list().map(({ threadId }) => threadId), service);
  return service.subscribe((update) => {
    if (update.kind !== "scan") return;
    const incomplete = store.list().filter(({ incomplete }) => incomplete).map(({ threadId }) => threadId);
    if (incomplete.length) void refreshThreadCompletions(store, incomplete, service);
  });
}

export async function restoreThreadLifecycle(file: string, service: RecoveryService = changesService(), store = threadStore()): Promise<void> {
  let pending: string[];
  try {
    await service.restore();
    pending = await service.pendingThreadDeletes();
  } catch (error) {
    console.warn("[changes] source control was unavailable at startup", error);
    store.persistTo(file, [], true);
    return;
  }
  // Once the ledger reports a pending removal, a failed write must never fall back to restoring that thread.
  store.persistTo(file, pending);
  if (pending.length) await service.completeThreadDeletes(pending);
}

/** Stop taking new turns before acknowledging the shell's quit handshake. */
export async function flushThreadLifecycle(service: Pick<ChangesService, "flush"> = changesService(), store = threadStore()): Promise<void> {
  store.beginShutdown();
  store.flush();
  try { await service.flush(); }
  finally { store.flush(); }
}
