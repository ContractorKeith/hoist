import type {
  App,
  LockClaim,
  LockRow,
  Preview,
  Release,
  Store,
} from "../../store/interface";

export class FakeStore implements Store {
  private key = crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  secretKey(): Promise<CryptoKey> {
    return this.key;
  }
  readonly configRows = new Map<number, Record<string, string>>();
  config(id: number): Record<string, string> {
    return { ...this.configRows.get(id) };
  }
  setConfig(id: number, key: string, value: string): void {
    this.configRows.set(id, { ...this.config(id), [key]: value });
  }
  unsetConfig(id: number, key: string): void {
    const values = this.config(id);
    delete values[key];
    this.configRows.set(id, values);
  }
  setRetention(id: number, retention: number): void {
    const app = this.appRows.find((a) => a.id === id);
    if (app) app.retention = retention;
  }
  markPruned(id: number): void {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.pruned_at = new Date().toISOString();
  }
  readonly previewRows: Preview[] = [];
  setVolumePath(appId: number, path: string | null): void {
    const app = this.appRows.find((a) => a.id === appId);
    if (app) app.volume_path = path;
  }
  setPendingMainBranch(appId: number, branch: string | null): void {
    const app = this.appRows.find((a) => a.id === appId);
    if (app) app.pending_main_branch = branch;
  }
  setMainBranch(appId: number, branch: string): void {
    const app = this.appRows.find((a) => a.id === appId);
    if (app) app.main_branch = branch;
  }
  removePreview(appId: number, branch: string): void {
    const index = this.previewRows.findIndex(
      (p) => p.app_id === appId && p.branch === branch,
    );
    if (index >= 0) this.previewRows.splice(index, 1);
  }
  stopBranchReleases(appId: number, branch: string): void {
    for (const row of this.releases(appId))
      if (row.branch === branch) row.status = "stopped";
  }
  previews(appId: number): Preview[] {
    return structuredClone(this.previewRows.filter((p) => p.app_id === appId));
  }
  upsertPreview(input: Preview): void {
    const row = this.previewRows.find(
      (p) => p.app_id === input.app_id && p.branch === input.branch,
    );
    if (row) Object.assign(row, input);
    else this.previewRows.push({ ...input });
  }
  deletePreview(appId: number, branch: string): void {
    for (const rows of [this.rows, this.previewRows])
      for (let i = rows.length - 1; i >= 0; i--)
        if (rows[i]?.app_id === appId && rows[i]?.branch === branch)
          rows.splice(i, 1);
  }
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
    const previews = structuredClone(this.previewRows);
    try {
      return action();
    } catch (error) {
      this.rows.splice(0, this.rows.length, ...snapshot);
      this.previewRows.splice(0, this.previewRows.length, ...previews);
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
    for (const row of this.previews(id)) this.deletePreview(id, row.branch);
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
