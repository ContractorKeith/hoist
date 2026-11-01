import { pollHealth } from "../core/health";
import { healthPath } from "../core/validation";
import { port as validatePort } from "./validation";

export async function checkHealth(port: number, path: string): Promise<void> {
  validatePort(port);
  healthPath(path);
  await pollHealth(path, async (signal) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      redirect: "manual",
      signal,
    });
    await response.body?.cancel();
    return response.status;
  });
}
