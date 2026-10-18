import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["{shared,server,web,scripts,electron}/**/*.test.ts"], passWithNoTests: true },
});
