import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["{shared,server,web,scripts}/**/*.test.ts"], passWithNoTests: true },
});
