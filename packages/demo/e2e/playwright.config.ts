import { defineConfig } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    globalSetup: __dirname + "/global-setup.ts",
    globalTeardown: __dirname + "/global-teardown.ts",

    testDir: ".",
    // Serialize specs: they share one dev server, one SQLite file, and the
    // /reset endpoint, so running them in parallel causes cross-test interference.
    workers: 1,
    fullyParallel: false,
    use: {
        baseURL: "http://localhost:3000",
    },
});
