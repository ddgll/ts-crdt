import { ChildProcess } from "child_process";

async function globalTeardown() {
  console.log("Global teardown: Stopping the server...");
  const serverProcess: ChildProcess = Reflect.get(global, "__SERVER_PROCESS__");
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
