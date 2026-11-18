import type { ChangesActionResult, ChangesJobs, ChangesRestartHarness, ChangesStatus } from "../../shared/changes.ts";
import type { ServerMsg } from "../../shared/protocol.ts";
import { changesApi, ChangesError } from "./api.ts";
import { ChangesList, element } from "./list.ts";
import { ChangesReview, MessageDraft, scopeFromHash } from "./review.ts";
import "./changes.css";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const availability = $("availability");
const branch = $("branch");
const notices = $("notices");
const jobList = $("jobs");
const scopeNote = $("scope-note");
const result = $("result");
const form = $<HTMLFormElement>("commit-form");
const message = $<HTMLTextAreaElement>("commit-message");
const messageStatus = $("message-status");
const selectionNote = $("selection-note");
const commitButton = $<HTMLButtonElement>("commit");
const separatelyButton = $<HTMLButtonElement>("commit-separately");

const review = new ChangesReview();
const draft = new MessageDraft();
const list = new ChangesList($("groups"), review, selectionChanged, requireReview);
let status: ChangesStatus = { kind: "loading" };
let refreshRequest: AbortController | undefined;
let jobsRequest: AbortController | undefined;
let draftRequest: AbortController | undefined;
let draftTimer: ReturnType<typeof setTimeout> | undefined;
let jobsKey = "";
let busy = false;
let scopeVersion = 0;

const activeProject = () => "project" in status ? status.project : undefined;
const errorText = (error: unknown): string => error instanceof ChangesError ? error.message : "Couldn’t reach source control.";

function renderReview(): void {
  const { view, scope, scopedGroup } = review;
  list.render();
  branch.hidden = !view;
  $("branch-name").textContent = view?.branch?.replace(/^refs\/heads\//, "") ?? "Detached HEAD";
  $("branch-state").textContent = !view ? "" : view.branch === null
    ? (view.base ? `· ${view.base.slice(0, 12)}` : "") : view.base === null ? "· No commits yet" : "";
  branch.title = [view?.branch, view?.base].filter(Boolean).join(" · ");
  $("file-count").textContent = view ? `${view.changedFiles} ${view.changedFiles === 1 ? "changed file" : "changed files"}` : "";
  const texts = [...view?.notices ?? []];
  if (view?.branch === null) texts.push("Check out a branch to commit.");
  notices.replaceChildren(...texts.map(text => element("p", "notice", text)));
  scopeNote.hidden = !view || scope === null || !!scopedGroup;
  scopeNote.textContent = "This thread has no owned changes in the current project.";
  form.hidden = !view?.components.length;
  selectionChanged();
}

function showAvailability(): void {
  switch (status.kind) {
    case "none": availability.textContent = "Choose a project folder to see its changes."; break;
    case "loading": availability.textContent = "Loading changes…"; break;
    case "ready": availability.textContent = !review.view ? "Loading changes…"
      : review.view.components.length ? "" : "No changes to review."; break;
    default: availability.textContent = status.reason;
  }
}

function showResult(reason = "", commits: readonly string[] = [], error = false): void {
  result.replaceChildren();
  if (commits.length) {
    const summary = element("p", "commit-result", commits.length === 1 ? "Committed " : "Commits made ");
    commits.forEach((id, index) => {
      if (index) summary.append(", ");
      summary.append(element("code", undefined, id));
    });
    result.append(summary);
  }
  if (reason) result.append(element("p", error ? "error" : "", reason));
}

function syncActions(): void {
  list.syncSelection(busy);
  message.disabled = busy;
  const disabled = busy || !review.selection || !message.value.trim() || review.view?.branch === null;
  commitButton.disabled = disabled;
  separatelyButton.disabled = disabled;
  for (const button of jobList.querySelectorAll("button")) button.disabled = busy;
  const missing = review.missingRequirement;
  selectionNote.hidden = !missing;
  selectionNote.textContent = missing ? `Also select ${missing.files.map(file => file.path).join(", ")} to include the dependent change.` : "";
}

function cancelPrefill(): void {
  draftRequest?.abort();
  clearTimeout(draftTimer);
  messageStatus.textContent = "";
}

function selectionChanged(): void {
  const selection = review.selection;
  const version = draft.update(selection);
  if (!selection || version !== undefined) cancelPrefill();
  if (message.value !== draft.text) message.value = draft.text;
  syncActions();
  if (!selection || version === undefined) return;

  const controller = new AbortController();
  draftRequest = controller;
  messageStatus.textContent = "Preparing…";
  draftTimer = setTimeout(async () => {
    try {
      const response = await changesApi.message(selection, controller.signal);
      if (controller.signal.aborted) return;
      if (draft.resolve(version, response.message)) message.value = draft.text;
      messageStatus.textContent = "";
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ChangesError && error.status === 409) requireReview(error);
      else messageStatus.textContent = "Enter a commit message.";
    } finally {
      if (!controller.signal.aborted) syncActions();
    }
  }, 150);
}

function requireReview(error: ChangesError, reload = true): void {
  review.invalidate();
  showResult(error.message, error.result.commits, true);
  selectionChanged();
  if (reload) void refresh();
}

function renderJobs(project: string | undefined, jobs?: ChangesJobs, error = ""): void {
  const key = JSON.stringify([project, jobs, error]);
  if (key === jobsKey) return;
  jobsKey = key;
  jobList.replaceChildren();
  if (!project) return;
  for (const job of jobs?.jobs ?? []) {
    const row = element("div", "notice job");
    const text = element("p");
    if (job.commit) {
      const commit = element("code", undefined, job.commit.slice(0, 12));
      commit.title = job.commit;
      text.append(commit, " ");
    }
    text.append(job.reason ?? "Commit in progress…");
    row.append(text);
    if (job.canFix) {
      const fix = element("button", undefined, "Fix");
      fix.type = "button";
      fix.setAttribute("aria-label", job.commit ? `Fix staging for ${job.commit.slice(0, 12)}` : "Fix staging");
      fix.onclick = () => { void runAction(project, () => changesApi.fix({ project, jobId: job.id }), "Git’s staging area was updated."); };
      row.append(fix);
    }
    jobList.append(row);
  }
  for (const harness of jobs?.restart ?? []) {
    const name = harnessName(harness);
    const row = element("div", "notice job");
    row.append(element("p", undefined, `Couldn’t confirm ${name} stopped.`));
    const restart = element("button", undefined, `Restart ${name}`);
    restart.type = "button";
    restart.onclick = () => { void runAction(project, () => changesApi.restart({ project, generation: review.view?.generation, harness }), `${name} restarted.`); };
    row.append(restart);
    jobList.append(row);
  }
  if (error) jobList.append(element("p", "notice", error));
  syncActions();
}

const harnessName = (harness: ChangesRestartHarness) => harness === "codex" ? "Codex" : "opencode";

async function loadJobs(project: string): Promise<void> {
  if (jobsRequest) return;
  const controller = new AbortController();
  jobsRequest = controller;
  try {
    const jobs = await changesApi.jobs(project, controller.signal);
    if (!controller.signal.aborted && activeProject() === project) renderJobs(project, jobs);
  } catch (error) {
    if (!controller.signal.aborted && activeProject() === project && !(error instanceof ChangesError && error.status === 409)) {
      renderJobs(project, undefined, errorText(error));
    }
  } finally {
    if (jobsRequest === controller) jobsRequest = undefined;
  }
}

function applyStatus(next: ChangesStatus): void {
  const previousProject = activeProject();
  status = next;
  const project = activeProject();
  if (project !== previousProject) {
    jobsRequest?.abort();
    jobsRequest = undefined;
    renderJobs(undefined);
    if (previousProject !== undefined) {
      draft.reset();
      list.resetDisclosures();
      showResult();
    }
  }
  if (next.kind !== "ready" || review.project !== next.project) {
    review.suspend();
    renderReview();
  }
  showAvailability();
}

async function refresh(hint?: ChangesStatus, retry = true): Promise<void> {
  refreshRequest?.abort();
  const controller = new AbortController();
  refreshRequest = controller;
  try {
    const next = hint ?? await changesApi.status(controller.signal);
    if (controller.signal.aborted) return;
    applyStatus(next);
    const project = activeProject();
    if (project) void loadJobs(project);
    if (next.kind !== "ready") return;

    const { generation } = next;
    if (review.view?.generation !== generation || review.project !== next.project) {
      const view = await changesApi.view(next.project, controller.signal);
      if (!controller.signal.aborted) applyView(next.project, view);
    } else {
      applyView(next.project, review.view);
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    if (error instanceof ChangesError && error.status === 409) {
      requireReview(error, false);
      if (retry) return refresh(undefined, false);
    }
    review.suspend();
    renderReview();
    availability.textContent = errorText(error);
  }
}

function applyView(project: string, view: NonNullable<ChangesReview["view"]>): void {
  const changed = review.view !== view;
  const previousTicks = review.selected.size;
  review.apply(project, view);
  if (changed) renderReview();
  else selectionChanged();
  if (review.selected.size < previousTicks && !result.textContent) {
    showResult("Some changes are no longer selected. Review your selection.", [], true);
  }
  showAvailability();
}

async function submit(separately: boolean): Promise<void> {
  const selection = review.selection;
  const text = message.value.trim();
  if (busy || !selection || !text || review.view?.branch === null) return;
  const currentScope = scopeVersion;
  busy = true;
  syncActions();
  showResult("Committing…");
  try {
    const response = await changesApi.commit({ ...selection, message: text, separately, scopeThreadId: review.scope ?? undefined });
    if (activeProject() !== selection.project) return;
    if ("reason" in response) {
      if (response.commits?.length && currentScope === scopeVersion) review.invalidate();
      showResult(response.reason, response.commits, true);
    } else {
      if (currentScope === scopeVersion) {
        review.invalidate();
        draft.reset();
      }
      showResult("", response.commits);
    }
  } catch (error) {
    if (activeProject() !== selection.project) return;
    if (error instanceof ChangesError && error.status === 409) requireReview(error, false);
    else showResult(errorText(error), error instanceof ChangesError ? error.result.commits : [], true);
  } finally {
    busy = false;
    selectionChanged();
    refreshAfterAction();
  }
}

function refreshAfterAction(): void {
  jobsRequest?.abort();
  jobsRequest = undefined;
  void refresh();
}

async function runAction(project: string, action: () => Promise<ChangesActionResult>, success: string): Promise<void> {
  if (busy || activeProject() !== project) return;
  busy = true;
  syncActions();
  showResult();
  try {
    const response = await action();
    if (activeProject() !== project) return;
    if ("reason" in response) showResult(response.reason, response.commits, true);
    else showResult(success);
  } catch (error) {
    if (activeProject() !== project) return;
    if (error instanceof ChangesError && error.status === 409) requireReview(error, false);
    else showResult(errorText(error), [], true);
  } finally {
    busy = false;
    syncActions();
    refreshAfterAction();
  }
}

function openScope(): void {
  scopeVersion++;
  review.open(scopeFromHash(location.hash));
  draft.reset();
  cancelPrefill();
  list.resetDisclosures();
  showResult();
  renderReview();
  $("main").scrollTop = 0;
  void refresh();
}

message.oninput = () => { draft.edit(message.value); cancelPrefill(); syncActions(); };
form.onsubmit = event => { event.preventDefault(); void submit(false); };
separatelyButton.onclick = () => { void submit(true); };
window.addEventListener("hashchange", openScope);
window.addEventListener("focus", () => { void refresh(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
setInterval(() => {
  const project = activeProject();
  if (!document.hidden && project) void loadJobs(project);
}, 2000);

function watchChanges(): void {
  const url = new URL("/ws?view=changes", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  // A read-only connection must not become the speaker for thread audio.
  const socket = new WebSocket(url);
  socket.onopen = () => { void refresh(); };
  socket.onclose = () => { setTimeout(watchChanges, 1000); };
  socket.onmessage = ({ data }: MessageEvent<string>) => {
    const event = JSON.parse(data) as ServerMsg;
    if (event.type === "changes.status") void refresh(event.status);
    if (event.type === "changes.updated" && (event.project !== review.project || event.generation !== review.view?.generation)) void refresh();
  };
}

watchChanges();
openScope();
