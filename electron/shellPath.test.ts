import { describe, expect, it } from "vitest";
import { loginShellPath, mergePath } from "./shellPath.ts";

describe("mergePath", () => {
  it("puts the shell's folders first and keeps each folder once", () => {
    expect(mergePath("/opt/homebrew/bin:/usr/bin:/Users/me/.local/bin", "/usr/bin:/bin")).toBe("/opt/homebrew/bin:/usr/bin:/Users/me/.local/bin:/bin");
    expect(mergePath("", "/usr/bin:/bin")).toBe("/usr/bin:/bin");
  });
});

describe("loginShellPath", () => {
  it("reads the login shell's PATH, ignoring what its startup files print", () => {
    expect(loginShellPath("/bin/sh")).toContain("/usr/bin");
  });
  it("is empty when the shell can't run", () => {
    expect(loginShellPath("/nonexistent/shell")).toBe("");
  });
});
