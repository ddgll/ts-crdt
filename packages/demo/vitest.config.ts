import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    // Only unit tests. `e2e/` holds Playwright specs, which vitest cannot run —
    // they are driven by `pnpm e2e` instead.
    include: ["**/tests/**/*.test.ts"],
    exclude: ["e2e/**", "**/node_modules/**", "**/dist/**"],
  },
});
