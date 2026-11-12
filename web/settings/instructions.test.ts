import { describe, expect, it, vi } from "vitest";
import type { InstructionEdit, InstructionsBridge, InstructionsSnapshot } from "../../shared/instructions.ts";
import { mountInstructions } from "./instructions.ts";

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (err: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function setup(bridge: InstructionsBridge) {
  const node = () => ({ value: "", textContent: "", disabled: false, hidden: false, classList: { toggle: vi.fn() }, oninput: () => {}, onclick: () => {} });
  const el = { global: node(), project: node(), projectCard: node(), folder: node(), globalStatus: node(), projectStatus: node(), retry: node() };
  let switchProject!: () => void;
  mountInstructions(bridge, cb => { switchProject = cb; }, el as unknown as Parameters<typeof mountInstructions>[2]);
  return { el, switchProject: () => switchProject() };
}

describe("instruction textareas", () => {
  it("allows global instructions without a folder, saves multiline text, and clears a field", async () => {
    const save = vi.fn(async (_edit: InstructionEdit) => {});
    const { el } = setup({ get: async () => ({ global: "", project: "", projectDir: null }), save });
    await tick();
    expect(el.global.disabled).toBe(false);
    expect(el.project.disabled).toBe(true);
    el.global.value = "Run tests.\nThen commit.";
    el.global.oninput();
    await tick();
    expect(save).toHaveBeenLastCalledWith({ scope: "global", text: "Run tests.\nThen commit." });
    expect(el.globalStatus.textContent).toContain("Saved.");
    el.global.value = "";
    el.global.oninput();
    expect(save).toHaveBeenLastCalledWith({ scope: "global", text: "" });
  });

  it("ignores an old folder load that resolves after the new one", async () => {
    const first = deferred<InstructionsSnapshot>();
    const second = deferred<InstructionsSnapshot>();
    const get = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const save = vi.fn(async (_edit: InstructionEdit) => {});
    const { el, switchProject } = setup({ get, save });
    switchProject();
    second.resolve({ global: "G", project: "B", projectDir: "/b" });
    await tick();
    first.resolve({ global: "old", project: "A", projectDir: "/a" });
    await tick();
    expect(el.folder.textContent).toBe("/b");
    expect(el.project.value).toBe("B");
    el.project.value = "B updated";
    el.project.oninput();
    expect(save).toHaveBeenCalledWith({ scope: "project", projectDir: "/b", text: "B updated" });
  });

  it("retains a failed write across folder switches and retries it against its original folder", async () => {
    let dir = "/a";
    const pending = deferred<void>();
    const save = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const { el, switchProject } = setup({ get: async () => ({ global: "", project: "", projectDir: dir }), save });
    await tick();
    el.project.value = "A draft";
    el.project.oninput();
    dir = "/b";
    switchProject();
    await tick();
    pending.reject(new Error("Disk full"));
    await tick();
    expect(el.project.value).toBe("");
    expect(el.retry.hidden).toBe(false);
    el.project.value = "B instructions";
    el.project.oninput();
    await tick();
    dir = "/a";
    switchProject();
    await tick();
    expect(el.project.value).toBe("A draft");
    el.retry.onclick();
    await tick();
    expect(save).toHaveBeenLastCalledWith({ scope: "project", projectDir: "/a", text: "A draft" });
    expect(el.retry.hidden).toBe(true);
  });
});
