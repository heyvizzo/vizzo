import { describe, expect, it } from "vitest";
import type { ThreadInfo } from "../../shared/threads.ts";
import { PlaybackClock, decisionBadges, detailOf, engineStatus, fmtBytes, fmtElapsed, fmtEstimate, groupThreads, jobHeadline, markerLabel, pageLabel, replyNeedsReply, runningLabel, spokenOf, sttLanguageWarning, threadsOnPage } from "./logic.ts";

describe("markerLabel", () => {
  it("keeps short questions and collapses whitespace", () => {
    expect(markerLabel("  Audit   every page ")).toBe("Audit every page");
    expect(markerLabel("")).toBe("");
  });
  it("cuts long questions at a word boundary", () => {
    const out = markerLabel("Compare our three plans against the two main competitors in detail", 40);
    expect(out).toBe("Compare our three plans against the two…");
    expect(out.length).toBeLessThanOrEqual(41);
  });
  it("hard-cuts when there is no usable space", () => {
    expect(markerLabel("a".repeat(50), 10)).toBe("a".repeat(10) + "…");
  });
});

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
    expect(jobHeadline({ state: "done", intent: "question", elapsedMs: 74_000 }, 80_000)).toBe("Background question · 1 min 14 s");
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

const thread = (threadId: string, pageUrl: string, createdAt: number): ThreadInfo => ({
  threadId, pageUrl, lastInteractionAt: createdAt, createdAt, title: threadId, state: "idle", intent: "task", summary: "", unread: false, awaitingReply: false, messages: [],
  anchor: { pageUrl, selector: "a", domPath: "body > a", dataSource: null, label: null, text: null, role: null, tag: "a", bounds: { x: 0, y: 0, width: 1, height: 1 } },
});

describe("element threads", () => {
  it("replyNeedsReply: clarify, or a reply that ends with a question", () => {
    expect(replyNeedsReply("clarify", "Which one.")).toBe(true);
    expect(replyNeedsReply("answer", "Want me to change it?")).toBe(true);
    expect(replyNeedsReply("task", "Should I use “purple?”")).toBe(true);
    expect(replyNeedsReply("task", "Sure, on it.")).toBe(false);
    expect(replyNeedsReply(undefined, "")).toBe(false);
  });

  it("threadsOnPage ignores the #fragment", () => {
    const ts = [thread("a", "http://x/p.html", 1), thread("b", "http://x/p.html?plan=pro", 2)];
    expect(threadsOnPage(ts, "http://x/p.html#faq").map((t) => t.threadId)).toEqual(["a"]);
    expect(threadsOnPage(ts, null)).toEqual([]);
  });

  it("groupThreads: current page first, then by latest activity", () => {
    const ts = [thread("a", "http://x/1", 5), thread("b", "http://x/2", 9), thread("c", "http://x/3", 1), thread("d", "http://x/3", 3)];
    const g = groupThreads(ts, "http://x/3#top");
    expect(g.map((x) => [x.pageUrl, x.current, x.threads.map((t) => t.threadId)])).toEqual([
      ["http://x/3", true, ["d", "c"]], ["http://x/2", false, ["b"]], ["http://x/1", false, ["a"]],
    ]);
  });

  it("groupThreads: opening a thread doesn't move it; a new message does", () => {
    const a = thread("a", "http://x/1", 1), b = thread("b", "http://x/1", 2);
    a.lastInteractionAt = 99; // focused (panel opened)
    expect(groupThreads([a, b], null)[0]!.threads.map((t) => t.threadId)).toEqual(["b", "a"]);
    a.messages = [{ id: "m", turnId: "t", at: 5, role: "user", kind: "followup", text: "hi" }];
    expect(groupThreads([a, b], null)[0]!.threads.map((t) => t.threadId)).toEqual(["a", "b"]);
  });

  it("fmtBytes", () => {
    expect(fmtBytes(84 * 1024 * 1024)).toBe("84 MB");
    expect(fmtBytes(1.44 * 1024 ** 3)).toBe("1.4 GB");
  });

  it("pageLabel", () => {
    expect(pageLabel("http://localhost:5173/")).toBe("localhost:5173");
    expect(pageLabel("https://ex.com/pricing.html?plan=pro")).toBe("ex.com/pricing.html?plan=pro");
    expect(pageLabel("file:///Users/me/site/index.html")).toBe("index.html");
    expect(pageLabel("not a url")).toBe("not a url");
  });
});

describe("sttLanguageWarning", () => {
  it("is quiet on auto and on models that follow the pin", () => {
    expect(sttLanguageWarning("openrouter_fish_transcribe_1", "auto")).toBeUndefined();
    expect(sttLanguageWarning("scribe_v2", "ro")).toBeUndefined();
    expect(sttLanguageWarning("openrouter_nemotron_asr", "en")).toBeUndefined();
  });
  it("points Romanian at Scribe", () => {
    expect(sttLanguageWarning("openrouter_nemotron_asr", "ro")).toBe("NVIDIA Nemotron 3.5 ASR (OpenRouter) doesn't transcribe Romanian reliably. Romanian works with ElevenLabs Scribe v2 Realtime, Parakeet TDT 0.6B v3 (on-device), WhisperKit large-v3 turbo (on-device).");
  });
  it("says Fish ignores the setting", () => {
    expect(sttLanguageWarning("openrouter_fish_transcribe_1", "en")).toMatch(/ignores the Language setting/);
  });
});

describe("engineStatus", () => {
  const e = (x: object) => ({ kind: "stt" as const, engine: "parakeet", label: "Parakeet", state: "ready" as const, ...x });
  it("says nothing for a cloud model", () => {
    expect(engineStatus(null, "stt", [])).toBeNull();
  });
  it("loading, loaded with the time and RAM, or the error", () => {
    expect(engineStatus("parakeet", "stt", [e({ state: "loading" })])).toEqual({ state: "loading", text: "Loading Parakeet…" });
    expect(engineStatus("parakeet", "stt", [e({ loadMs: 2500, ramBytes: 2.3 * 1024 ** 3 })])).toEqual({ state: "ready", text: "Parakeet loaded in 2.5 s · 2.3 GB RAM" });
    expect(engineStatus("parakeet", "stt", [e({ state: "error", error: "not installed" })])).toEqual({ state: "error", text: "Couldn't load Parakeet: not installed" });
  });
  it("matches the kind, and shows loading while a switch is pending", () => {
    expect(engineStatus("parakeet", "tts", [e({})])!.state).toBe("idle");
    expect(engineStatus("parakeet", "stt", [], true)).toEqual({ state: "loading", text: "Loading…" });
  });
});
