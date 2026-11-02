import type { DockerClient } from "../adapters/interfaces";
import type { App, Release, Store } from "../store/interface";

export async function eligibleReleases(
  store: Store,
  docker: DockerClient,
  app: App,
): Promise<Release[]> {
  const rows = store
    .releases(app.id)
    .filter((row) => row.branch === (app.main_branch ?? "main"));
  if (!rows.some((row) => row.status === "live")) return [];
  const eligible: Release[] = [];
  for (const row of rows) {
    if (!["stopped", "built"].includes(row.status)) continue;
    try {
      await docker.imagePorts(row.image);
      eligible.push(row);
    } catch {
      /* An absent image cannot be rolled back. */
    }
  }
  return eligible;
}
export class Actions {
  private jobs = new Map<
    string,
    { owner: string; running: boolean; message: string }
  >();
  private pending = new Set<Promise<void>>();
  constructor(private run: (args: string[]) => Promise<void>) {}
  status(app: string, owner: string) {
    const job = this.jobs.get(app);
    return job?.owner === owner ? job : undefined;
  }
  start(app: string, owner: string, action: string, target: string): boolean {
    if (this.jobs.get(app)?.running) return false;
    const job = {
      owner,
      running: true,
      message: `${action === "rollback" ? "Rollback" : "Restart"} in progress…`,
    };
    this.jobs.set(app, job);
    const task = (async () => {
      try {
        await this.run([
          action,
          app,
          ...(action === "rollback" ? [target] : []),
        ]);
        job.message = "New release is live.";
      } catch (error) {
        console.error(error);
        job.message =
          "Action failed. Check the release log with the hoist CLI.";
      } finally {
        job.running = false;
      }
    })();
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return true;
  }
  async finish(): Promise<void> {
    await Promise.all(this.pending);
  }
}
