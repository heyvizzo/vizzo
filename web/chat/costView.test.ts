import { describe, expect, it } from "vitest";
import { costHeadline, fmtUsd } from "./costView.ts";

describe("costView", () => {
  it("formats small amounts with enough digits", () => {
    expect(fmtUsd(0.00018)).toBe("$0.0002");
    expect(fmtUsd(0.0312)).toBe("$0.031");
    expect(fmtUsd(1.239)).toBe("$1.24");
    expect(fmtUsd(0)).toBe("$0");
  });
  it("headline adds the background task to the turn", () => {
    expect(costHeadline({ items: [], total: 0.0312, jobs: [] })).toBe("cost $0.031");
    expect(costHeadline({ items: [], total: 0.0052, jobs: [{ label: "background task", items: [], total: 0.0139, running: false }] }))
      .toBe("cost $0.019 · turn $0.0052 + background task $0.014");
    expect(costHeadline({ items: [], total: 0.0052, jobs: [{ label: "background task", items: [], total: 0, running: true }] }))
      .toBe("cost $0.0052+ · turn $0.0052 + background task $0 so far");
  });
});
