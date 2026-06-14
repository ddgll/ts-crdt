import { defineConfig } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    globalSetup: __dirname + "/global-setup.ts",
    globalTeardown: __dirname + "/global-teardown.ts",

    testDir: ".",
    use: {
        baseURL: "http://localhost:3000",
    },
});
