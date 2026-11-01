import type { App, Release, Store } from "../../store/interface";

export class FakeStore implements Store {
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
    const row = { ...input, id: this.rows.length + 1 };
    this.rows.push(row);
    return row;
  }
  completeRelease(id: number): void {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`release ${id} no longer exists`);
    row.status = "built";
  }
  failRelease(id: number): void {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`release ${id} no longer exists`);
    row.status = "failed";
  }
}
