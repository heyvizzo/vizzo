import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMsg } from "../shared/protocol.ts";
import type { HarnessThread, OpenHarnessThread, SolveInThread, SolveInThreadOpts } from "./adapters/types.ts";
import type { SessionRef } from "./adapters/harnesses.ts";
import { backgroundCentralSession, centralSession, continueConversationSession, finishJobSession, openJobSession, solveCentral } from "./centralSession.ts";
import { getConversation, resetConversation } from "./conversation.ts";
import { harnessSessionInfo } from "./adapters/sessionInfo.ts";
import { Floor } from "./threads/floor.ts";
import { resetThreadStore } from "./threads/store.ts";

const choice = { provider: "codex", model: "m" } as const;
const opts: Omit<SolveInThreadOpts, "thread" | "kind"> = {
  mark: () => {}, question: "hello", pointing: [], onDelta: () => {}, onSpokenLine: () => {},
};
beforeEach(() => { resetThreadStore(); });

describe("central session metadata", () => {
  it("hides an unused continuation and keeps a completed task available in its original native context", async () => {
    const opened: HarnessThread[] = [];
    const notes: string[] = [];
    const openThread: OpenHarnessThread = (o) => {
      let ref: SessionRef | undefined;
      let spec: HarnessThread["spec"];
      const handle = {
        id: `h-${opened.length}`, choice: o.choice, get spec() { return spec; },
        session: () => ref, release: vi.fn(async () => {}), close: vi.fn(), live: false,
        send: vi.fn(async () => {
          notes.push(ref ? o.notes?.() ?? "" : o.replay());
          spec ??= { role: "solver", harness: "codex", model: "pinned", system: "", project: "/project" };
          ref ??= { id: handle.id + "-native" };
          o.onSession?.();
          return { text: "done", usage: {}, filesTouched: [], reopened: false };
        }),
        abort: vi.fn(),
      } as unknown as HarnessThread;
      opened.push(handle);
      return handle;
    };
    const solveInThread: SolveInThread = async (o) => o.thread.send(o.question, o.onDelta, 1000);
    const deps = { openThread, solveInThread };
    await solveCentral(deps, choice, "first", opts);
    const original = centralSession()!;
    backgroundCentralSession(original);
    expect(harnessSessionInfo(centralSession())).toBeNull();
    await finishJobSession(original);
    expect(original.release).toHaveBeenCalledOnce();
    expect(original.close).not.toHaveBeenCalled();
    getConversation().push({ turnId: "elsewhere", user: "Another question", assistant: "Another answer", detail: "", approach: "pipeline" });
    continueConversationSession(original.session!()!.id);
    await solveCentral(deps, { provider: "grok", model: "changed" }, "followup", opts);
    expect(centralSession()).toBe(original);
    expect(original.send).toHaveBeenCalledTimes(2);
    expect(original.spec?.model).toBe("pinned");
    expect(notes.at(-1)).toContain("Another answer");
    expect(opened).toHaveLength(2); // The continued task did not open another context.
    resetConversation();
    expect(original.close).toHaveBeenCalledOnce();
    expect(() => continueConversationSession(original.session!()!.id)).toThrow("no longer available");
  });

  it("refuses to select a background session until its work has finished", async () => {
    const handle = { session: () => ({ id: "busy-job" }), release: vi.fn(async () => {}), close: vi.fn() } as unknown as HarnessThread;
    openJobSession(() => handle, choice, []);
    expect(() => continueConversationSession("busy-job")).toThrow("finish");
    await finishJobSession(handle);
    continueConversationSession("busy-job");
    expect(centralSession()).toBe(handle);
  });

  it("broadcasts starting and native IDs, keeps the pinned provider, and clears it on reset", async () => {
    const store = resetThreadStore();
    const sent: ServerMsg[] = [];
    const floor = new Floor({ send: () => {}, sendAudio: () => {} });
    store.subscribe({ send: (m) => sent.push(m), floor });
    let ref: SessionRef | undefined;
    let changed: (() => void) | undefined;
    const close = vi.fn();
    const handle = {
      id: "hthread-internal", choice, spec: { role: "solver", harness: "codex", model: "m", system: "", project: "/pinned" },
      session: () => ref, close,
    } as unknown as HarnessThread;
    const openThread: OpenHarnessThread = vi.fn((o) => { changed = o.onSession; return handle; });
    const solveInThread: SolveInThread = async () => {
      ref = { id: "native-central" };
      changed?.();
      return { text: "done", usage: {}, filesTouched: [] };
    };
    await solveCentral({ openThread, solveInThread }, choice, "first", opts);
    const events = () => sent.filter((m) => m.type === "conversation.session");
    expect(events()).toMatchObject([
      { session: { provider: "codex" } },
      { session: { provider: "codex", id: "native-central", resumeCommand: expect.stringMatching(/^cd \/pinned && .* resume native-central$/) } },
    ]);
    expect(events()[0]).not.toHaveProperty("session.id");
    await solveCentral({ openThread, solveInThread }, { provider: "grok", model: "changed" }, "next", opts);
    expect(openThread).toHaveBeenCalledOnce();
    expect(events()).toHaveLength(2);
    expect(centralSession()).toBe(handle);
    resetConversation();
    expect(close).toHaveBeenCalledOnce();
    expect(events().at(-1)).toEqual({ type: "conversation.session", session: null });
    floor.close();
  });
});
