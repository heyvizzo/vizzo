import { describe, expect, it } from "vitest";
import { PlaybackClock, decisionBadges, detailOf, fmtElapsed, fmtEstimate, jobHeadline, runningLabel, spokenOf } from "./logic.ts";

describe("fmtEstimate", () => {
  it("formats seconds, minutes, hours", () => {
    expect(fmtEstimate(null)).toBe("");
    expect(fmtEstimate(NaN)).toBe("");
    expect(fmtEstimate(0.4)).toBe("<1 s");
    expect(fmtEstimate(8.4)).toBe("~8 s");
    expect(fmtEstimate(59)).toBe("~59 s");
    expect(fmtEstimate(60)).toBe("~1 min");
    expect(fmtEstimate(90)).toBe("~1.5 min");
    expect(fmtEstimate(120)).toBe("~2 min");
    expect(fmtEstimate(130)).toBe("~2 min");
    expect(fmtEstimate(15 * 60 + 20)).toBe("~15 min");
    expect(fmtEstimate(5400)).toBe("~1.5 h");
  });
});

describe("fmtElapsed", () => {
  it("formats elapsed ms", () => {
    expect(fmtElapsed(-5)).toBe("0 s");
    expect(fmtElapsed(999)).toBe("0 s");
    expect(fmtElapsed(42_300)).toBe("42 s");
    expect(fmtElapsed(74_000)).toBe("1 min 14 s");
    expect(fmtElapsed(120_000)).toBe("2 min");
    expect(fmtElapsed(12 * 60_000 + 5000)).toBe("12 min");
  });
});

describe("decisionBadges", () => {
  it("labels each intent", () => {
    expect(decisionBadges({ intent: "question", estimateS: 8, background: false })).toEqual(["question", "~8 s"]);
    expect(decisionBadges({ intent: "task", estimateS: 120, background: true })).toEqual(["task", "~2 min", "working in background"]);
    expect(decisionBadges({ intent: "task", estimateS: null, background: false })).toEqual(["task"]);
    expect(decisionBadges({ intent: "clarify", estimateS: 5, background: false })).toEqual(["asking you a follow-up"]);
    expect(decisionBadges({ intent: "answer", estimateS: null, background: false })).toEqual(["direct answer"]);
  });
});

describe("detailOf / spokenOf", () => {
  it("strips the SPOKEN line", () => {
    expect(detailOf("SPOKEN: Short.\n\nLong answer\nmore")).toBe("Long answer\nmore");
    expect(detailOf("SPOKEN: still streaming")).toBe("");
    expect(detailOf("no prefix here")).toBe("no prefix here");
    expect(spokenOf("SPOKEN: It's done.")).toBe("It's done.");
    expect(spokenOf("Plain.")).toBe("Plain.");
  });
});

describe("job labels", () => {
  it("headlines by state", () => {
    expect(jobHeadline({ state: "running", intent: "task" }, 12_000)).toBe("Background task · running 12 s");
    expect(jobHeadline({ state: "done", intent: "question", elapsedMs: 74_000 }, 80_000)).toBe("Done in 1 min 14 s");
    expect(jobHeadline({ state: "failed", intent: "task" }, 3000)).toBe("Failed after 3 s");
    expect(runningLabel(0)).toBe("");
    expect(runningLabel(1)).toBe("1 task running");
    expect(runningLabel(2)).toBe("2 tasks running");
  });
});

describe("PlaybackClock", () => {
  it("accumulates queued audio and resets", () => {
    const c = new PlaybackClock();
    expect(c.isPlaying(0)).toBe(false);
    c.push(48000, 1000); // 1 s of audio from t=1000
    c.push(24000, 1100); // queued after → until 2500
    expect(c.isPlaying(2400)).toBe(true);
    expect(c.remainingMs(2000)).toBe(500);
    expect(c.isPlaying(2500)).toBe(false);
    c.push(48000, 5000); // gap: starts from now
    expect(c.isPlaying(5900)).toBe(true);
    c.reset();
    expect(c.isPlaying(5900)).toBe(false);
  });
});
