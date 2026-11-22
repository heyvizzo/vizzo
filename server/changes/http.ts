import type { IncomingMessage, ServerResponse } from "node:http";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { readChangesPreferences } from "../../electron/settings.ts";
import { changedFileCount, groupComponents, type ChangesJobs, type ChangesRestartHarness, type ChangesSelectionRequest, type ChangesStatus } from "../../shared/changes.ts";
import { beginTask } from "../activity.ts";
import { restartSharedHarness } from "../adapters/harnesses.ts";
import { changesService, type ChangesService } from "./changesService.ts";
import { commitReviewedChanges, selectChanges } from "./commitSeparately.ts";
import type { CommitJobSummary } from "./ledger.ts";
import { MAX_COMMIT_MESSAGE, prepareCommitMessage, type CommitMessageModel } from "./message.ts";
import type { LedgerProject } from "./project.ts";
import { REVIEW_AGAIN, type ScanResponse } from "./scanRuntime.ts";

const MAX_BODY = 2 * 1024 * 1024;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const LOCAL_ADDRESS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** The desktop dev and packaged proxies forward Host and Origin from their same-origin loopback pages. */
export function isLocalChangesRequest(req: IncomingMessage): boolean {
  const { host, origin, "sec-fetch-site": site } = req.headers;
  if (!host || !LOCAL_HOST.test(host) || !LOCAL_ADDRESS.has(req.socket.remoteAddress ?? "")) return false;
  if (site && site !== "same-origin" && site !== "none") return false;
  try { return origin === undefined || origin === new URL(`http://${host}`).origin; }
  catch { return false; }
}

export function changesStatus(service = changesService()): ChangesStatus {
  const state = service.scanner.status();
  switch (state.kind) {
    case "none": case "loading": return { kind: state.kind };
    case "non-repository": return { kind: state.kind, reason: state.reason };
    case "unavailable": return { kind: state.kind, reason: state.reason, ...(state.project && { project: state.project.id }) };
    case "ready": {
      const { view } = state;
      const components = new Map(view.components.map(component => [component.id, component]));
      const threads = view.groups.filter(({ writer, own, tied }) => writer.kind === "thread" && (own.length || tied.length));
      const threadFileCounts = Object.fromEntries(threads.map(group => [group.writer.id, changedFileCount(groupComponents(group, components))]));
      return {
        kind: state.kind, project: state.project.id, generation: view.generation, changedFiles: view.changedFiles,
        ownedThreadIds: threads.map(({ writer }) => writer.id), threadFileCounts,
      };
    }
  }
}

export function subscribeChangesStatus(service: ChangesService, listener: (status: ChangesStatus) => void): () => void {
  let previous = JSON.stringify(changesStatus(service));
  return service.scanner.subscribeStatus(() => {
    const status = changesStatus(service);
    const key = JSON.stringify(status);
    if (key === previous) return;
    previous = key;
    listener(status);
  });
}

export interface ChangesHttpOptions {
  service?: ChangesService;
  model?: CommitMessageModel;
  restart?: typeof restartSharedHarness;
}

class RequestError extends Error {
  constructor(readonly status: number, reason: string) { super(reason); }
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function data<T>(response: ScanResponse<T>): T {
  if (response.status !== 200) throw new RequestError(response.status, response.reason);
  return response.data;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !value.includes("\0");
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validSelection(body: Record<string, unknown>): body is Record<string, unknown> & ChangesSelectionRequest {
  return identifier(body.project) && validGeneration(body.generation) && Array.isArray(body.components) &&
    body.components.length > 0 && body.components.every(identifier) && new Set(body.components).size === body.components.length;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const media = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (media !== "application/json") throw new RequestError(415, "Send a JSON request");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) {
      req.resume();
      throw new RequestError(413, "The request is too large");
    }
    chunks.push(chunk);
  }
  try {
    const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (result && typeof result === "object" && !Array.isArray(result)) return result as Record<string, unknown>;
  } catch { /* Report malformed JSON below. */ }
  throw new RequestError(400, "Invalid JSON request");
}

function query(url: URL, key: string): string {
  const values = url.searchParams.getAll(key);
  const value = values[0];
  if (values.length !== 1 || !value || value.includes("\0")) throw new RequestError(400, `Invalid ${key}`);
  return value;
}

function selection(service: ChangesService, body: ChangesSelectionRequest) {
  const review = data(service.scanner.reviewCurrent(body.project, body.generation));
  const selected = selectChanges(review.view, body.components);
  if ("reason" in selected) throw new RequestError(409, selected.reason);
  return { review, components: selected.components };
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function visibleJobs(jobs: readonly CommitJobSummary[]): CommitJobSummary[] {
  return jobs.filter(({ status }) => status === "blocked" || status === "indeterminate" || status === "repair-needed");
}

async function pendingRestarts(service: ChangesService, project: LedgerProject): Promise<ChangesRestartHarness[]> {
  const { executions } = await service.writerSnapshot(project.id);
  const harnesses = await Promise.all(executions.map(async ({ phase, harness, folder }) => {
    if (!folder || phase !== "unconfirmed" || (harness !== "codex" && harness !== "opencode")) return;
    const scope = await realpath(folder).catch(() => folder);
    if (contains(project.scope, scope) || contains(scope, project.scope)) return harness;
  }));
  return [...new Set(harnesses.filter((harness) => harness !== undefined))];
}

function stillCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new RequestError(409, REVIEW_AGAIN);
}

export function changeRoutes(service: ChangesService, opts: ChangesHttpOptions = {}) {
  const { model, restart = restartSharedHarness } = opts;
  return async (req: IncomingMessage, res: ServerResponse, url: URL, isEnabled: () => boolean = () => true): Promise<void> => {
    const path = url.pathname;
    const verifyEnabled = () => {
      if (!isEnabled()) throw new RequestError(404, "Git source control is disabled");
    };
    try {
      if (!isLocalChangesRequest(req)) throw new RequestError(403, "Source control requires the local Vizzo window");
      verifyEnabled();
      if (req.method === "GET") {
        if (path === "/api/changes/status") return respond(res, 200, changesStatus(service));
        if (!["/api/changes", "/api/changes/diff", "/api/changes/jobs"].includes(path)) throw new RequestError(404, "Unknown source-control route");
        const project = query(url, "project");
        if (!identifier(project)) throw new RequestError(400, "Invalid project");
        if (path === "/api/changes") return respond(res, 200, data(service.scanner.snapshot(project)));
        if (path === "/api/changes/diff") {
          const raw = query(url, "generation");
          const generation = Number(raw);
          const component = query(url, "component");
          if (!/^\d+$/.test(raw) || !validGeneration(generation) || !identifier(component)) {
            throw new RequestError(400, "Invalid diff request");
          }
          return respond(res, 200, data(service.scanner.diff(project, generation, component, query(url, "path"))));
        }
        const context = data(service.scanner.projectContext(project));
        const [jobs, restart] = await Promise.all([
          service.jobs(project), pendingRestarts(service, context.project).catch(() => []),
        ]);
        verifyEnabled();
        stillCurrent(context.isCurrent);
        return respond(res, 200, {
          jobs: visibleJobs(jobs).map(({ jobId, commit, reason, canFix, project: jobProject }) => {
            const inScope = contains(context.project.scope, jobProject.scope);
            const jobScope = relative(context.project.root, jobProject.scope) || ".";
            return {
              id: jobId, commit, canFix: canFix && inScope,
              reason: inScope ? reason : `${reason ?? "An unfinished commit blocks this repository"} (Commit folder: ${jobScope})`,
            };
          }),
          restart,
        } satisfies ChangesJobs);
      }
      if (req.method !== "POST") throw new RequestError(405, "Method not allowed");
      if (!["/api/changes/message", "/api/changes/commit", "/api/changes/fix", "/api/changes/restart"].includes(path)) {
        throw new RequestError(404, "Unknown source-control route");
      }
      const body = await readJson(req);
      verifyEnabled();
      if (path === "/api/changes/message" || path === "/api/changes/commit") {
        if (!validSelection(body)) throw new RequestError(400, "Select at least one change from a valid review");
        const chosen = selection(service, body);
        if (path === "/api/changes/message") {
          if (res.destroyed) return;
          const controller = new AbortController();
          const disconnect = () => controller.abort();
          res.once("close", disconnect);
          try {
            const [writers, threads] = await Promise.all([
              service.writerSnapshot(body.project), service.threadMessageContexts(chosen.review.project, chosen.components),
            ]);
            controller.signal.throwIfAborted();
            verifyEnabled();
            data(service.scanner.reviewCurrent(body.project, body.generation));
            const { commitMessageTier, commitMessageTimeoutSeconds } = readChangesPreferences();
            const draft = await prepareCommitMessage(chosen.review, chosen.components, writers, {
              tier: commitMessageTier, timeoutSeconds: commitMessageTimeoutSeconds[commitMessageTier],
              model, threads, signal: controller.signal,
            });
            controller.signal.throwIfAborted();
            verifyEnabled();
            data(service.scanner.reviewCurrent(body.project, body.generation));
            return respond(res, 200, draft);
          } finally {
            res.off("close", disconnect);
          }
        }
        if (typeof body.message !== "string" || !body.message.trim() || body.message.includes("\0") ||
            body.message.length > MAX_COMMIT_MESSAGE || typeof body.separately !== "boolean" ||
            (body.scopeThreadId !== undefined && !identifier(body.scopeThreadId))) {
          throw new RequestError(400, "Enter a valid commit message and commit mode");
        }
        const finish = beginTask("Commit selected changes");
        try {
          const result = await commitReviewedChanges(service, chosen.review, chosen.components, body.message, body.separately, body.scopeThreadId, isEnabled);
          await service.scanner.refresh();
          finish("reason" in result ? "failed" : "done");
          return respond(res, "reason" in result ? 409 : 200, result);
        } finally { finish("failed"); }
      }
      if (!identifier(body.project)) throw new RequestError(400, "Invalid project");
      if (path === "/api/changes/fix") {
        if (!identifier(body.jobId)) throw new RequestError(400, "Invalid commit job");
        const context = data(service.scanner.projectContext(body.project));
        const jobs = visibleJobs(await service.jobs(body.project));
        verifyEnabled();
        stillCurrent(context.isCurrent);
        if (!jobs.some(({ jobId, canFix, project }) => jobId === body.jobId && canFix && contains(context.project.scope, project.scope))) {
          throw new RequestError(409, "This commit job cannot be fixed in the current project");
        }
        const result = await service.fix(body.project, body.jobId, () => isEnabled() && context.isCurrent());
        if (result.status !== "done") throw new RequestError(409, "message" in result ? result.message : REVIEW_AGAIN);
      } else {
        if ((body.harness !== "codex" && body.harness !== "opencode") ||
            (body.generation !== undefined && !validGeneration(body.generation))) {
          throw new RequestError(400, "Invalid shared harness restart request");
        }
        if (body.generation === undefined && service.scanner.status().kind === "ready") throw new RequestError(409, REVIEW_AGAIN);
        const context = data(service.scanner.projectContext(body.project, body.generation));
        const harnesses = await pendingRestarts(service, context.project);
        verifyEnabled();
        stillCurrent(context.isCurrent);
        if (!harnesses.includes(body.harness)) throw new RequestError(409, "No matching writer is waiting for confirmation");
        await restart(body.harness);
      }
      await service.scanner.refresh();
      respond(res, 200, { ok: true });
    } catch (error) {
      if (res.destroyed) return;
      const status = error instanceof RequestError ? error.status : 409;
      if (status === 409) void service.scanner.refresh();
      respond(res, status, { reason: error instanceof Error ? error.message : String(error) });
    }
  };
}
