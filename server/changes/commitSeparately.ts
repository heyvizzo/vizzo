import { randomUUID } from "node:crypto";
import type { ChangeComponent, ChangesCommitResult, ChangesView } from "../../shared/changes.ts";
import type { ChangesService } from "./changesService.ts";
import type { CommitRequest } from "./commitTransaction.ts";
import { carryChangesAfterPublication, changeWriterId, type ChangeOwnershipReceipt } from "./components.ts";
import { REVIEW_AGAIN, type ScanReview } from "./scanRuntime.ts";

export function selectChanges(view: ChangesView, ids: readonly string[]): { components: ChangeComponent[] } | { reason: string } {
  const selected = new Set(ids);
  const components = view.components.filter(({ id }) => selected.has(id));
  if (!ids.length || components.length !== ids.length) return { reason: REVIEW_AGAIN };
  for (const { selectable, reason, requires } of components) {
    if (!selectable) return { reason: reason ?? REVIEW_AGAIN };
    if (requires?.some((id) => !selected.has(id))) return { reason: "Select the required changes as well" };
  }
  return { components };
}

function separate(view: ChangesView, selected: readonly ChangeComponent[], scopeThreadId?: string): string[][] {
  const unassigned = new Set(selected.map(({ id }) => id));
  const batches = [];
  const scoped = view.groups.find(({ writer }) => writer.kind === "thread" && writer.id === scopeThreadId);
  const groups = scoped ? [scoped, ...view.groups.filter((group) => group !== scoped)] : view.groups;
  for (const { own, tied } of groups) {
    const ids = [...own, ...tied].filter((id) => unassigned.delete(id));
    if (ids.length) batches.push(ids);
  }
  if (unassigned.size) batches.push([...unassigned]);
  return batches;
}

function commitRequest(review: ScanReview, components: readonly ChangeComponent[], message: string): CommitRequest {
  return {
    jobId: randomUUID(), projectId: review.project.id, generation: review.view.generation,
    componentIds: components.map(({ id }) => id),
    writerIds: [...new Set(components.flatMap(({ writers }) => writers.map(changeWriterId)))],
    selection: { kind: "explicit", otherComponentIds: components.filter(({ other }) => other).map(({ id }) => id) },
    message,
  };
}

/** Each job freezes its own selection under Git's locks and may only follow a proven publication from this request. */
export async function commitReviewedChanges(service: ChangesService, reviewed: ScanReview,
  selected: readonly ChangeComponent[], message: string, separately: boolean, scopeThreadId?: string): Promise<ChangesCommitResult> {
  let batches = separately ? separate(reviewed.view, selected, scopeThreadId) : [selected.map(({ id }) => id)];
  let review = reviewed;
  const commits: string[] = [];
  const refused = (reason: string) => ({ reason, ...(commits.length && { commits }) });
  try {
    while (batches.length) {
      const [ids, ...remaining] = batches;
      const selection = selectChanges(review.view, ids!);
      if ("reason" in selection) return refused(selection.reason);
      const request = commitRequest(review, selection.components, message);
      let receipt: ChangeOwnershipReceipt | undefined;
      const result = await service.commit(review.project, request, async (context) => {
        const frozen = await review.scanAndFreeze(context);
        receipt = frozen?.ownership;
        return frozen;
      }, review.isProjectCurrent);
      if (result.status === "done" || result.status === "repair-needed") commits.push(result.commit);
      if (result.status !== "done") return refused(result.reason);
      if (!remaining.length) return { commits };
      if (!receipt) return refused(REVIEW_AGAIN);
      const after = await service.scanner.reviewAfterPublication(review, result.commit);
      if (after.status !== 200) return refused(after.reason);
      const carried = carryChangesAfterPublication(review.graph, after.data.graph, receipt, remaining.flat());
      // Keep a missing id so that the corresponding job refuses in order, after any still-valid earlier jobs.
      batches = remaining.map((batch) => batch.map((id) => carried.get(id) ?? id));
      review = after.data;
    }
    return { commits };
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error));
  }
}
