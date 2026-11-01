import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./interface";
import { migrations, schemaVersion } from "./migrations";

export class SqliteStore implements Store {
  readonly db: Database;

  constructor(dataDir: string) {
    if (!dataDir || dataDir.includes("\0"))
      throw new Error("Invalid data directory");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new Database(join(dataDir, "hoist.db"), {
      create: true,
      strict: true,
    });
    try {
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
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

  close(): void {
    this.db.close();
  }
}
