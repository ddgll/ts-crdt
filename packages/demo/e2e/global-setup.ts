import { spawn } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const sleep = promisify(setTimeout);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log("Global setup: Starting the server...");

async function globalSetup() {
  // Delete the database file to ensure a clean state
  const dbPath = path.resolve(__dirname, "../sqlite.db");
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    console.log("Deleted existing database file.");
  }

  const serverProcess = spawn("pnpm", ["dev"], {
    cwd: path.resolve(__dirname, ".."),
    stdio: "pipe",
    detached: true,
  });

  serverProcess.stdout?.on("data", (data) => {
    console.log(`server: ${data}`);
  });

  serverProcess.stderr?.on("data", (data) => {
    console.error(`server error: ${data}`);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__SERVER_PROCESS__ = serverProcess;

  await sleep(5000); // Wait for the server to be ready
}

export default globalSetup;
