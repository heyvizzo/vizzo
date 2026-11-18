import type {
  ChangeDiff, ChangesActionResult, ChangesCommitRequest, ChangesCommitResult, ChangesFixRequest,
  ChangesJobs, ChangesMessageResult, ChangesRefusal, ChangesRestartRequest, ChangesSelectionRequest,
  ChangesStatus, ChangesView,
} from "../../shared/changes.ts";

export class ChangesError extends Error {
  constructor(readonly status: number, readonly result: ChangesRefusal) { super(result.reason); }
}

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/changes${route}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || body === null) {
    throw new ChangesError(response.status, {
      reason: typeof body?.reason === "string" ? body.reason : "Couldn’t reach source control.",
      commits: Array.isArray(body?.commits) ? body.commits : undefined,
    });
  }
  return body as T;
}

const query = (values: Record<string, string>): string => `?${new URLSearchParams(values)}`;
const post = <T>(route: string, body: object, signal?: AbortSignal): Promise<T> => request<T>(route, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
});

export const changesApi = {
  status: (signal: AbortSignal) => request<ChangesStatus>("/status", { signal }),
  view: (project: string, signal: AbortSignal) => request<ChangesView>(query({ project }), { signal }),
  diff: (project: string, generation: number, component: string, path: string) =>
    request<ChangeDiff>(`/diff${query({ project, generation: String(generation), component, path })}`),
  jobs: (project: string, signal: AbortSignal) => request<ChangesJobs>(`/jobs${query({ project })}`, { signal }),
  message: (body: ChangesSelectionRequest, signal: AbortSignal) => post<ChangesMessageResult>("/message", body, signal),
  commit: (body: ChangesCommitRequest) => post<ChangesCommitResult>("/commit", body),
  fix: (body: ChangesFixRequest) => post<ChangesActionResult>("/fix", body),
  restart: (body: ChangesRestartRequest) => post<ChangesActionResult>("/restart", body),
};
