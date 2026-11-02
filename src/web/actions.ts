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
  private controller = new AbortController();
  private signal: AbortSignal;
  private interrupt = () => {
    for (const job of this.jobs.values())
      if (job.running) job.message = "Interrupted by shutdown";
  };
  constructor(
    private run: (args: string[], signal: AbortSignal) => Promise<void>,
    shutdown?: AbortSignal,
  ) {
    this.signal = shutdown
      ? AbortSignal.any([shutdown, this.controller.signal])
      : this.controller.signal;
    this.signal.addEventListener("abort", this.interrupt, { once: true });
  }
  status(app: string, owner: string) {
    const job = this.jobs.get(app);
    return job?.owner === owner ? job : undefined;
  }
  start(app: string, owner: string, action: string, target: string): boolean {
    if (this.signal.aborted || this.jobs.get(app)?.running) return false;
    const job = {
      owner,
      running: true,
      message: `${action === "rollback" ? "Rollback" : "Restart"} in progress…`,
    };
    this.jobs.set(app, job);
    const task = (async () => {
      try {
        await this.run(
          [action, app, ...(action === "rollback" ? [target] : [])],
          this.signal,
        );
        job.message = this.signal.aborted
          ? "Interrupted by shutdown"
          : "New release is live.";
      } catch (error) {
        if (!this.signal.aborted) console.error(error);
        job.message = this.signal.aborted
          ? "Interrupted by shutdown"
          : "Action failed. Check the release log with the hoist CLI.";
      } finally {
        job.running = false;
      }
    })();
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return true;
  }
  async finish(timeoutMs = 30000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(this.pending),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.controller.abort(new Error("Action shutdown deadline"));
            resolve();
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", this.interrupt);
      if (this.signal.aborted)
        for (const job of this.jobs.values()) job.running = false;
    }
  }
}
