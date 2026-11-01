import { Database } from "bun:sqlite";
import { join } from "node:path";
import { privatePath } from "../data";
import type { App, LockClaim, LockRow, Release, Store } from "./interface";
import { migrations, schemaVersion } from "./migrations";

export class SqliteStore implements Store {
  readonly db: Database;

  constructor(dataDir: string) {
    if (!dataDir || dataDir.includes("\0"))
      throw new Error("Invalid data directory");
    privatePath(dataDir, true, false, dataDir);
    privatePath(join(dataDir, "hoist.db"), false, false, dataDir);
    this.db = new Database(join(dataDir, "hoist.db"), {
      create: true,
      strict: true,
    });
    try {
      this.db.exec(
        "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;",
      );
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  migrate(): void {
    this.db
      .transaction(() => {
        const version = this.db
          .query<{ user_version: number }, []>("PRAGMA user_version")
          .get();
        if (!version) throw new Error("Missing schema version");
        const current = version.user_version;
        if (current > schemaVersion)
          throw new Error("Database schema is newer than hoist");
        for (const [index, sql] of migrations.entries()) {
          if (index < current) continue;
          this.db.exec(sql);
          this.db.exec(`PRAGMA user_version = ${index + 1}`);
        }
      })
      .immediate();
  }

  latestReleaseNumber(appId: number, branch: string): number {
    return (
      this.db
        .query<{ number: number }, [number, string]>(
          "SELECT COALESCE(MAX(number), 0) AS number FROM releases WHERE app_id = ? AND branch = ?",
        )
        .get(appId, branch)?.number ?? 0
    );
  }

  transaction<T>(action: () => T): T {
    return this.db.transaction(action).immediate();
  }
  createApp(name: string, domain: string, healthPath: string): App {
    const row = this.db
      .query<App, [string, string, string]>(
        "INSERT INTO apps (name, domain, health_path) VALUES (?, ?, ?) RETURNING *",
      )
      .get(name, domain, healthPath);
    if (!row) throw new Error("App insert failed");
    return row;
  }
  app(name: string): App | null {
    return this.db
      .query<App, [string]>("SELECT * FROM apps WHERE name = ?")
      .get(name);
  }
  apps(): App[] {
    return this.db.query<App, []>("SELECT * FROM apps ORDER BY name").all();
  }
  deleteApp(id: number): void {
    this.db.run("DELETE FROM apps WHERE id = ?", [id]);
  }
  releases(appId: number): Release[] {
    return this.db
      .query<Release, [number]>(
        "SELECT * FROM releases WHERE app_id = ? ORDER BY id",
      )
      .all(appId);
  }
  insertRelease(input: Omit<Release, "id">): Release {
    const row = this.db
      .query<Release, [number, string, number, string, string, string, string]>(
        "INSERT INTO releases (app_id, branch, number, git_sha, image, config_json, status) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
      )
      .get(
        input.app_id,
        input.branch,
        input.number,
        input.git_sha,
        input.image,
        input.config_json,
        input.status,
      );
    if (!row) throw new Error("Release insert failed");
    return row;
  }
  completeRelease(id: number): void {
    const result = this.db.run(
      "UPDATE releases SET status = 'built' WHERE id = ? AND status = 'building'",
      [id],
    );
    if (!result.changes)
      throw new Error(`release ${id} no longer exists or status changed`);
  }
  failRelease(id: number): void {
    const result = this.db.run(
      "UPDATE releases SET status = 'failed' WHERE id = ? AND status NOT IN ('live', 'stopped')",
      [id],
    );
    if (!result.changes) throw new Error(`release ${id} no longer exists`);
  }

  setReleaseState(
    id: number,
    status: "live" | "stopped",
    containerId: string | null = null,
    expectedStatus: "built" | "live" = status === "live" ? "built" : "live",
  ): void {
    const result = this.db.run(
      "UPDATE releases SET status = ?, container_id = ? WHERE id = ? AND status = ?",
      [status, containerId, id, expectedStatus],
    );
    if (!result.changes) throw new Error(`release ${id} no longer exists`);
  }

  lock(name: string): LockRow | null {
    return this.db
      .query<LockRow, [string]>("SELECT * FROM locks WHERE name = ?")
      .get(name);
  }
  acquireLock(
    name: string,
    pid: number,
    now: string,
    alive: (pid: number) => boolean,
  ): LockClaim {
    return this.transaction(() => {
      const previous = this.lock(name);
      if (
        previous &&
        alive(previous.owner_pid) &&
        Date.parse(previous.heartbeat_at) > Date.parse(now) - 60000
      )
        return { acquired: false, ownerPid: previous.owner_pid };
      this.db.run(
        "INSERT INTO locks (name, owner_pid, heartbeat_at, acquired_at, child_pid) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(name) DO UPDATE SET owner_pid=excluded.owner_pid, heartbeat_at=excluded.heartbeat_at, acquired_at=excluded.acquired_at",
        [name, pid, now, now],
      );
      return { acquired: true, previous };
    });
  }
  refreshLock(
    name: string,
    pid: number,
    acquiredAt: string,
    now: string,
  ): boolean {
    return (
      this.db.run(
        "UPDATE locks SET heartbeat_at = ? WHERE name = ? AND owner_pid = ? AND acquired_at = ?",
        [now, name, pid, acquiredAt],
      ).changes === 1
    );
  }
  releaseLock(name: string, pid: number, acquiredAt: string): void {
    this.db.run(
      "DELETE FROM locks WHERE name = ? AND owner_pid = ? AND acquired_at = ?",
      [name, pid, acquiredAt],
    );
  }
  setLockChild(
    name: string,
    pid: number,
    acquiredAt: string,
    childPid: number | null,
  ): void {
    if (
      !this.db.run(
        "UPDATE locks SET child_pid = ? WHERE name = ? AND owner_pid = ? AND acquired_at = ?",
        [childPid, name, pid, acquiredAt],
      ).changes
    )
      throw new Error(`lock ${name} ownership changed`);
  }

  close(): void {
    this.db.close();
  }
}
