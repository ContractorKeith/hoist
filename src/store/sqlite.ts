import { Database } from "bun:sqlite";
import { join } from "node:path";
import { keyfile, verifyKeyfile } from "../adapters/keyfile";
import { privatePath } from "../data";
import type { App, Preview, Release, Store } from "./interface";
import { LockStore } from "./locks";
import { migrations, schemaVersion } from "./migrations";

export function databaseError(dataDir: string, error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;
  if (code === "SQLITE_NOTADB" || message.includes("file is not a database"))
    return new Error(
      `${join(dataDir, "hoist.db")} is not a SQLite database; restore it from your backup.`,
      { cause: error },
    );
  if (
    code?.startsWith("SQLITE_READONLY") ||
    ["EACCES", "EROFS"].includes(code ?? "") ||
    /readonly|read-only/i.test(message)
  )
    return new Error(`${dataDir} is read-only; fix its mode and owner.`, {
      cause: error,
    });
  return error;
}

export class SqliteStore extends LockStore implements Store {
  readonly db: Database;

  constructor(readonly dataDir: string) {
    super();
    if (!dataDir || dataDir.includes("\0"))
      throw new Error("Invalid data directory");
    let opened: Database | undefined;
    try {
      privatePath(dataDir, true, false, dataDir);
      privatePath(join(dataDir, "hoist.db"), false, false, dataDir);
      this.db = opened = new Database(join(dataDir, "hoist.db"), {
        create: true,
        strict: true,
      });
      this.db.exec(
        "PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;",
      );
      this.migrate();
    } catch (error) {
      opened?.close();
      throw databaseError(dataDir, error);
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
          throw new Error(
            `Database schema version ${current} is newer than this hoist (${schemaVersion}); upgrade hoist.`,
          );
        for (const [index, sql] of migrations.entries()) {
          if (index < current) continue;
          this.db.exec(sql);
          this.db.exec(`PRAGMA user_version = ${index + 1}`);
        }
      })
      .immediate();
  }

  private key?: Promise<CryptoKey>;
  private hasEncryptedConfig(): boolean {
    return !!this.db
      .query<{ encrypted: number }, []>(
        "SELECT EXISTS(SELECT 1 FROM config UNION ALL SELECT 1 FROM releases WHERE config_json <> '{}') AS encrypted",
      )
      .get()?.encrypted;
  }
  secretKey(verifyFile = false): Promise<CryptoKey> {
    this.key ??= keyfile(this.dataDir, () => !this.hasEncryptedConfig());
    if (!verifyFile) return this.key;
    return this.key.then(async (key) => {
      try {
        await verifyKeyfile(this.dataDir, key);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (this.hasEncryptedConfig())
          throw new Error(
            "secret.key is missing but encrypted config exists; restore the key from backup",
          );
        this.key = undefined;
        return this.secretKey(true);
      }
      return key;
    });
  }
  config(appId: number): Record<string, string> {
    return Object.fromEntries(
      this.db
        .query<{ key: string; value: string }, [number]>(
          "SELECT key, value FROM config WHERE app_id = ? ORDER BY key",
        )
        .all(appId)
        .map((row) => [row.key, row.value]),
    );
  }
  setConfig(appId: number, key: string, value: string): void {
    this.db.run(
      "INSERT INTO config (app_id, key, value) VALUES (?, ?, ?) ON CONFLICT(app_id, key) DO UPDATE SET value=excluded.value",
      [appId, key, value],
    );
  }
  unsetConfig(appId: number, key: string): void {
    this.db.run("DELETE FROM config WHERE app_id = ? AND key = ?", [
      appId,
      key,
    ]);
  }
  setRetention(appId: number, retention: number): void {
    this.db.run("UPDATE apps SET retention = ? WHERE id = ?", [
      retention,
      appId,
    ]);
  }
  markPruned(id: number): void {
    this.db.run(
      "UPDATE releases SET pruned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      [id],
    );
  }
  setVolumePath(appId: number, path: string | null): void {
    this.db.run("UPDATE apps SET volume_path = ? WHERE id = ?", [path, appId]);
  }
  setMainBranch(appId: number, branch: string): void {
    this.db.run("UPDATE apps SET main_branch = ? WHERE id = ?", [
      branch,
      appId,
    ]);
  }
  removePreview(appId: number, branch: string): void {
    this.db.run("DELETE FROM previews WHERE app_id = ? AND branch = ?", [
      appId,
      branch,
    ]);
  }
  stopBranchReleases(appId: number, branch: string): void {
    this.db.run(
      "UPDATE releases SET status = 'stopped' WHERE app_id = ? AND branch = ?",
      [appId, branch],
    );
  }
  previews(appId: number): Preview[] {
    return this.db
      .query<Preview, [number]>(
        "SELECT * FROM previews WHERE app_id = ? ORDER BY branch",
      )
      .all(appId);
  }
  upsertPreview(input: Preview): void {
    this.db.run(
      "INSERT INTO previews (app_id, branch, slug, last_push_at) VALUES (?, ?, ?, ?) ON CONFLICT(app_id, branch) DO UPDATE SET last_push_at = excluded.last_push_at",
      [input.app_id, input.branch, input.slug, input.last_push_at],
    );
  }
  deletePreview(appId: number, branch: string): void {
    this.transaction(() => {
      this.db.run("DELETE FROM releases WHERE app_id = ? AND branch = ?", [
        appId,
        branch,
      ]);
      this.db.run("DELETE FROM previews WHERE app_id = ? AND branch = ?", [
        appId,
        branch,
      ]);
    });
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

  close(): void {
    this.db.close();
  }
}
