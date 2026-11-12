import type { InstructionEdit, InstructionsBridge } from "../../shared/instructions.ts";

interface Elements {
  global: HTMLTextAreaElement;
  project: HTMLTextAreaElement;
  projectCard: HTMLElement;
  folder: HTMLElement;
  globalStatus: HTMLElement;
  projectStatus: HTMLElement;
  retry: HTMLButtonElement;
}

export function mountInstructions(bridge: InstructionsBridge, onProject: (cb: () => void) => void, el: Elements): void {
  let projectDir: string | null = null;
  let generation = 0;
  const versions = new Map<string, number>();
  const failed = new Map<string, InstructionEdit>();
  const keyOf = (edit: InstructionEdit) => edit.scope === "global" ? "global" : edit.projectDir;
  let loadFailed = false;
  const updateRetry = () => {
    el.retry.hidden = !loadFailed && failed.size === 0;
    el.retry.textContent = loadFailed ? "Retry loading" : "Retry unsaved changes";
  };
  const status = (scope: InstructionEdit["scope"], text: string, error = false) => {
    const node = scope === "global" ? el.globalStatus : el.projectStatus;
    node.textContent = text;
    node.classList.toggle("field-error", error);
  };

  async function save(edit: InstructionEdit): Promise<void> {
    const current = generation;
    const key = keyOf(edit);
    const version = (versions.get(key) ?? 0) + 1;
    versions.set(key, version);
    const visible = () => current === generation && (edit.scope === "global" || edit.projectDir === projectDir);
    if (visible()) status(edit.scope, "Saving…");
    try {
      await bridge.save(edit);
      if (version !== versions.get(key)) return;
      failed.delete(key);
      if (visible()) status(edit.scope, "Saved. Applies to the next request.");
    } catch (err) {
      if (version !== versions.get(key)) return;
      failed.set(key, edit);
      if (visible()) status(edit.scope, `Couldn't save: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    updateRetry();
  }

  async function load(): Promise<void> {
    const current = ++generation;
    el.global.disabled = el.project.disabled = true;
    el.projectCard.hidden = true;
    el.retry.hidden = true;
    status("global", "Loading…");
    status("project", "");
    try {
      const saved = await bridge.get();
      if (current !== generation) return;
      projectDir = saved.projectDir;
      // Preserve unsaved text if a write failed, including when returning to its folder.
      const globalDraft = failed.get("global");
      const projectDraft = projectDir ? failed.get(projectDir) : undefined;
      el.global.value = globalDraft?.text ?? saved.global;
      el.project.value = projectDraft?.scope === "project" && projectDraft.projectDir === projectDir ? projectDraft.text : saved.project;
      el.folder.textContent = projectDir ?? "Choose a project folder to add its instructions.";
      el.global.disabled = false;
      el.project.disabled = !projectDir;
      el.projectCard.hidden = !projectDir;
      status("global", globalDraft ? "Changes haven't been saved. Retry to save them." : "", !!globalDraft);
      status("project", projectDraft ? "Changes haven't been saved. Retry to save them." : "", !!projectDraft);
      loadFailed = false;
    } catch (err) {
      if (current !== generation) return;
      loadFailed = true;
      status("global", `Couldn't load instructions: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    updateRetry();
  }

  el.global.oninput = () => { void save({ scope: "global", text: el.global.value }); };
  el.project.oninput = () => {
    if (projectDir) void save({ scope: "project", text: el.project.value, projectDir });
  };
  el.retry.onclick = () => {
    if (loadFailed) void load();
    else for (const edit of failed.values()) void save(edit);
  };
  onProject(() => { void load(); });
  void load();
}
