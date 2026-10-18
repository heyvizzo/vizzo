import { describe, expect, it } from "vitest";
import { VAD_ATTACK_GAP_MS, VAD_ATTACK_MS, VAD_BARGE_ATTACK_MS, VAD_HANG_MAX_MS, VAD_HANG_MIN_MS, VAD_HANG_MS, clampHangMs, VAD_MIN_SPEECH_MS, attackMs, autoSpeechTooShort, createVad, disarmVad, stepVad, type Vad } from "./vad.ts";

const LINE = 0.05;

function opened(): Vad {
  const v = createVad();
  stepVad(v, 0.2, LINE, 0);
  expect(stepVad(v, 0.2, LINE, VAD_ATTACK_MS)).toBe("start");
  return v;
}

describe("stepVad", () => {
  it("starts once the level has stayed on or above the line for the attack", () => {
    const v = createVad();
    expect(stepVad(v, LINE, LINE, 0)).toBeNull();
    expect(stepVad(v, 0.2, LINE, VAD_ATTACK_MS - 1)).toBeNull();
    expect(stepVad(v, 0.2, LINE, VAD_ATTACK_MS)).toBe("start");
    expect(v.phase).toBe("open");
    expect(stepVad(v, 0.4, LINE, VAD_ATTACK_MS + 20)).toBeNull();
  });

  it("a zero attack starts on the crossing sample", () => {
    expect(stepVad(createVad(), 0.2, LINE, 10, VAD_HANG_MS, 0)).toBe("start");
  });

  it("a dip longer than the gap during the attack restarts the wait", () => {
    const v = createVad();
    stepVad(v, 0.2, LINE, 0);
    expect(stepVad(v, 0, LINE, 20)).toBeNull();
    expect(stepVad(v, 0, LINE, 20 + VAD_ATTACK_GAP_MS + 1)).toBeNull();
    const t = 40 + VAD_ATTACK_GAP_MS;
    expect(stepVad(v, 0.2, LINE, t)).toBeNull();
    expect(stepVad(v, 0.2, LINE, t + VAD_ATTACK_MS - 1)).toBeNull();
    expect(stepVad(v, 0.2, LINE, t + VAD_ATTACK_MS)).toBe("start");
  });

  it("barge-in: speech with short dips between syllables still opens the turn", () => {
    const v = createVad();
    let edge = null;
    // 16 ms frames: 80 ms over the line, 64 ms under, repeated (choppy speech while a reply plays).
    for (let t = 0; t <= VAD_BARGE_ATTACK_MS + 160 && edge === null; t += 16) {
      edge = stepVad(v, t % 144 < 80 ? 0.2 : 0.01, LINE, t, VAD_HANG_MS, VAD_BARGE_ATTACK_MS);
    }
    expect(edge).toBe("start");
  });

  it("does not send the turn until the level has stayed under the line for 2 seconds", () => {
    const v = opened();
    expect(stepVad(v, 0, LINE, 1_000)).toBeNull();
    expect(v.phase).toBe("hang");
    expect(stepVad(v, 0, LINE, 1_000 + VAD_HANG_MS - 1)).toBeNull();
    expect(stepVad(v, 0, LINE, 1_000 + VAD_HANG_MS)).toBe("stop");
    expect(v.phase).toBe("idle");
  });

  it("a rise during the hang keeps the turn open and the next dip waits another 2 seconds", () => {
    const v = opened();
    stepVad(v, 0, LINE, 1_000);
    expect(stepVad(v, 0.2, LINE, 1_000 + VAD_HANG_MS - 1)).toBeNull();
    expect(v.phase).toBe("open");
    stepVad(v, 0, LINE, 4_000);
    expect(stepVad(v, 0, LINE, 4_000 + VAD_HANG_MS - 1)).toBeNull();
    expect(stepVad(v, 0, LINE, 4_000 + VAD_HANG_MS)).toBe("stop");
  });

  it("ignores the line after a manual stop until the level falls under it", () => {
    const v = opened();
    disarmVad(v);
    expect(stepVad(v, 0.2, LINE, 0)).toBeNull();
    expect(stepVad(v, 0.2, LINE, 1_000)).toBeNull();
    expect(v.phase).toBe("idle");
    expect(stepVad(v, 0, LINE, 1_100)).toBeNull();
    expect(stepVad(v, 0.2, LINE, 1_100)).toBeNull();
    expect(stepVad(v, 0.2, LINE, 1_100 + VAD_ATTACK_MS)).toBe("start");
  });

  it("disarm during the hang cancels the pending stop", () => {
    const v = opened();
    stepVad(v, 0, LINE, 1_000);
    disarmVad(v);
    expect(stepVad(v, 0, LINE, 1_000 + VAD_HANG_MS + 500)).toBeNull();
    expect(v.phase).toBe("idle");
  });

  it("ignores a non-finite level or threshold", () => {
    const v = createVad();
    expect(stepVad(v, Number.NaN, LINE, 0)).toBeNull();
    expect(stepVad(v, 0.2, Number.POSITIVE_INFINITY, VAD_ATTACK_MS)).toBeNull();
    expect(v.phase).toBe("idle");
  });
});

describe("attackMs", () => {
  it("is short when idle and longer while a reply is in flight", () => {
    expect(attackMs(false)).toBe(VAD_ATTACK_MS);
    expect(attackMs(true)).toBe(VAD_BARGE_ATTACK_MS);
    expect(VAD_HANG_MS).toBe(2_000);
  });
});

describe("autoSpeechTooShort", () => {
  it("drops a bump and keeps a short word", () => {
    expect(autoSpeechTooShort(0)).toBe(true);
    expect(autoSpeechTooShort(VAD_MIN_SPEECH_MS - 1)).toBe(true);
    expect(autoSpeechTooShort(VAD_MIN_SPEECH_MS)).toBe(false);
    expect(autoSpeechTooShort(Number.NaN)).toBe(true);
  });
});

describe("clampHangMs", () => {
  it("defaults non-numbers and clamps to the range", () => {
    expect(clampHangMs(undefined)).toBe(VAD_HANG_MS);
    expect(clampHangMs(Number.NaN)).toBe(VAD_HANG_MS);
    expect(clampHangMs(100)).toBe(VAD_HANG_MIN_MS);
    expect(clampHangMs(60_000)).toBe(VAD_HANG_MAX_MS);
    expect(clampHangMs(3_500)).toBe(3_500);
  });
});
