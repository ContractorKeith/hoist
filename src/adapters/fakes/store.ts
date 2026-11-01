import type {
  App,
  LockClaim,
  LockRow,
  Release,
  Store,
} from "../../store/interface";

export class FakeStore implements Store {
  readonly lockRows = new Map<string, LockRow>();
  lock(name: string): LockRow | null {
    return structuredClone(this.lockRows.get(name) ?? null);
  }
  acquireLock(
    name: string,
    pid: number,
    now: string,
    alive: (pid: number) => boolean,
  ): LockClaim {
    const previous = this.lock(name);
    if (
      previous &&
      alive(previous.owner_pid) &&
      Date.parse(previous.heartbeat_at) > Date.parse(now) - 60000
    )
      return { acquired: false, ownerPid: previous.owner_pid };
    this.lockRows.set(name, {
      name,
      owner_pid: pid,
      heartbeat_at: now,
      acquired_at: now,
      child_pid: previous?.child_pid ?? null,
    });
    return { acquired: true, previous };
  }
  refreshLock(
    name: string,
    pid: number,
    acquiredAt: string,
    now: string,
  ): boolean {
    const row = this.lockRows.get(name);
    if (!row || row.owner_pid !== pid || row.acquired_at !== acquiredAt)
      return false;
    row.heartbeat_at = now;
    return true;
  }
  releaseLock(name: string, pid: number, acquiredAt: string): void {
    const row = this.lockRows.get(name);
    if (row?.owner_pid === pid && row.acquired_at === acquiredAt)
      this.lockRows.delete(name);
  }
  setLockChild(
    name: string,
    pid: number,
    acquiredAt: string,
    childPid: number | null,
  ): void {
    const row = this.lockRows.get(name);
    if (!row || row.owner_pid !== pid || row.acquired_at !== acquiredAt)
      throw new Error(`lock ${name} ownership changed`);
    row.child_pid = childPid;
  }
  readonly calls: { appId: number; branch: string }[] = [];
  readonly rows: Release[] = [];
  readonly appRows: App[] = [];
  // Kept for M0's read-only numbering contract.
  readonly releasesSeed: { appId: number; branch: string; number: number }[] =
    [];
  transaction<T>(action: () => T): T {
    const snapshot = structuredClone(this.rows);
    try {
      return action();
    } catch (error) {
      this.rows.splice(0, this.rows.length, ...snapshot);
      throw error;
    }
  }
  latestReleaseNumber(appId: number, branch: string): number {
    this.calls.push({ appId, branch });
    return Math.max(
      0,
      ...this.releasesSeed
        .filter((r) => r.appId === appId && r.branch === branch)
        .map((r) => r.number),
      ...this.releases(appId)
        .filter((r) => r.branch === branch)
        .map((r) => r.number),
    );
  }
  createApp(name: string, domain: string, health_path: string): App {
    if (this.app(name)) throw new Error("App already exists");
    const app = { id: this.appRows.length + 1, name, domain, health_path };
    this.appRows.push(app);
    return app;
  }
  app(name: string): App | null {
    return this.appRows.find((a) => a.name === name) ?? null;
  }
  apps(): App[] {
    return structuredClone(this.appRows);
  }
  deleteApp(id: number): void {
    this.appRows.splice(
      0,
      this.appRows.length,
      ...this.appRows.filter((a) => a.id !== id),
    );
    this.rows.splice(
      0,
      this.rows.length,
      ...this.rows.filter((r) => r.app_id !== id),
    );
  }
  releases(appId: number): Release[] {
    return this.rows.filter((r) => r.app_id === appId);
  }
  insertRelease(input: Omit<Release, "id">): Release {
    if (
      this.rows.some(
        (r) =>
          r.app_id === input.app_id &&
          r.branch === input.branch &&
          r.number === input.number,
      )
    )
      throw new Error("Duplicate release");
    const row = {
      created_at: new Date().toISOString(),
      ...input,
      id: this.rows.length + 1,
    };
    this.rows.push(row);
    return row;
  }
  completeRelease(id: number): void {
    const row = this.rows.find((r) => r.id === id);
    if (row?.status !== "building")
      throw new Error(`release ${id} no longer exists or status changed`);
    row.status = "built";
  }
  setReleaseState(
    id: number,
    status: "live" | "stopped",
    containerId: string | null = null,
    expectedStatus: "built" | "live" = status === "live" ? "built" : "live",
  ): void {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.status !== expectedStatus)
      throw new Error(`release ${id} no longer exists or status changed`);
    row.status = status;
    row.container_id = containerId;
  }
  failRelease(id: number): void {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.status === "live" || row.status === "stopped")
      throw new Error(`release ${id} no longer exists or status changed`);
    row.status = "failed";
  }
}
