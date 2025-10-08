import { ChildProcess } from "child_process";

async function globalTeardown() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  console.log("Global teardown: Stopping the server...");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const serverProcess = (global as any).__SERVER_PROCESS__ as ChildProcess;
  if (serverProcess && serverProcess.pid && !serverProcess.killed) {
    try {
      // Kill the entire process group
      process.kill(-serverProcess.pid, "SIGKILL");
      console.log("Server process group killed.");
    } catch (e) {
      console.error("Failed to kill server process group:", e);
    }
  }
}

export default globalTeardown;
