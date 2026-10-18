import { describe, expect, it } from "vitest";
import { finishedLine, finishMode, focusedThreadId, linePriority, reconcileText, reminderText } from "./policy.ts";

const t = (threadId: string, state: "running" | "idle" | "pending" | "failed", lastInteractionAt: number) => ({ threadId, state, lastInteractionAt });

describe("notice policy", () => {
  it("the focused thread is the one with the latest interaction", () => {
    expect(focusedThreadId([t("a", "idle", 1), t("b", "running", 5), t("c", "idle", 3)])).toBe("b");
    expect(focusedThreadId([])).toBeNull();
  });

  it("full when focused or nothing else runs; otherwise a reminder", () => {
    // Plan example: T1 finishes while T3 (focused) runs → reminder.
    const threads = [t("T1", "running", 24), t("T2", "idle", 9), t("T3", "running", 30)];
    expect(finishMode("T1", threads)).toBe("reminder");
    expect(finishMode("T3", threads)).toBe("full");
    expect(finishMode("T1", [t("T1", "running", 24), t("T3", "idle", 30)])).toBe("full");
  });

  it("reminders: one thread, a batch, Romanian", () => {
    expect(reminderText(["the red button"])).toBe("An earlier task on the red button finished. Want me to tell you about it?");
    expect(reminderText(["the red button", "the footer links"])).toBe("The tasks on the red button and the footer links finished. Want to hear about them?");
    expect(reminderText(["a", "b", "c"])).toBe("The tasks on a, b and c finished. Want to hear about them?");
    expect(reminderText(["butonul roșu"], "ro")).toBe("O sarcină anterioară pentru butonul roșu s-a terminat. Vrei să-ți spun despre ea?");
    expect(reminderText(["a", "b"], "ro")).toMatch(/^Sarcinile pentru a și b s-au terminat\./);
  });

  it("central lines, reconcile text, priorities", () => {
    expect(finishedLine("the red button", "It's bigger now.")).toBe("Red button task finished: It's bigger now.");
    expect(reconcileText(["web/a.css"])).toBe("web/a.css was also changed by another task meanwhile: re-read it and check your change is intact.");
    expect(reconcileText(["a.css", "b.ts"])).toMatch(/^a\.css and b\.ts were also changed/);
    expect(linePriority("result", true)).toBeGreaterThan(linePriority("result", false));
    expect(linePriority("result", false)).toBeGreaterThan(linePriority("reminder", false));
  });
});
