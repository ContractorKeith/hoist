import { readFile } from "node:fs/promises";
import { processAlive, wait } from "./app-lock";

// Only reap a recorded child whose executable and config belong to this HOIST_DIR.
export async function stopOrphanCaddy(
  pid: number | null,
  binary: string,
  configPath: string,
): Promise<void> {
  if (!pid || !processAlive(pid)) return;
  const belongs = async () => {
    const args = (
      await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")
    ).split("\0");
    return (
      args[0] === binary && args[args.indexOf("--config") + 1] === configPath
    );
  };
  if (!(await belongs())) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  const deadline = Date.now() + 5000;
  while (processAlive(pid) && (await belongs())) {
    if (Date.now() >= deadline) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      return;
    }
    await wait(50);
  }
}
