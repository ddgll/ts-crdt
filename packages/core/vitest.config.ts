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
        "src/crdtClient.ts",
        "src/crdtServer.ts",
      ],
      exclude: ["**/tests/**", "**/node_modules/**", "**/dist/**"],
      all: true,
    },
  },
});