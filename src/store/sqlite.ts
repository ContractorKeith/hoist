import { Database } from "bun:sqlite";
import { join } from "node:path";
import { privatePath } from "../data";
import type { App, Release, Store } from "./interface";
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
      "UPDATE releases SET status = 'built' WHERE id = ?",
      [id],
    );
    if (!result.changes) throw new Error(`release ${id} no longer exists`);
  }
  failRelease(id: number): void {
    const result = this.db.run(
      "UPDATE releases SET status = 'failed' WHERE id = ?",
      [id],
    );
    if (!result.changes) throw new Error(`release ${id} no longer exists`);
  }

  setReleaseState(
    id: number,
    status: Release["status"],
    containerId: string | null = null,
  ): void {
    const result = this.db.run(
      "UPDATE releases SET status = ?, container_id = ? WHERE id = ?",
      [status, containerId, id],
    );
    if (!result.changes) throw new Error(`release ${id} no longer exists`);
  }

  close(): void {
    this.db.close();
  }
}
