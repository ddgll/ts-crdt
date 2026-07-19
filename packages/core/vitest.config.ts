import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: [
        "src/crdtTypes/**/*.ts",
        "src/egWalker/**/*.ts",
        "src/eventGraph/**/*.ts",
        "src/server/**/*.ts",
        "src/crdtClient.ts",
        "src/logger.ts",
        "src/sync.ts",
      ],
      exclude: ["**/tests/**", "**/node_modules/**", "**/dist/**", "**/benchmarks/**"],
      all: true,
    },
  },
});