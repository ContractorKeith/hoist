import type { Database } from "bun:sqlite";

// Dashboard-only persistence keeps session material out of the core Store contract.
export class DashboardStore {
  constructor(private db: Database) {}
  password(): string | null {
    return (
      this.db
        .query<{ value: string }, []>(
          "SELECT value FROM settings WHERE key = 'owner_password'",
        )
        .get()?.value ?? null
    );
  }
  savePassword(hash: string): void {
    this.db
      .transaction(() => {
        this.db.run(
          "INSERT INTO settings VALUES ('owner_password', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [hash],
        );
        this.db.run("DELETE FROM sessions");
      })
      .immediate();
  }
  createSession(hash: string, expires: string): void {
    this.db.run("DELETE FROM sessions WHERE expires_at <= ?", [
      new Date().toISOString(),
    ]);
    this.db.run("INSERT INTO sessions VALUES (?, ?)", [hash, expires]);
  }
  session(hash: string, now: string): string | null {
    return (
      this.db
        .query<{ expires_at: string }, [string, string]>(
          "SELECT expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?",
        )
        .get(hash, now)?.expires_at ?? null
    );
  }
  deleteSession(hash: string): void {
    this.db.run("DELETE FROM sessions WHERE token_hash = ?", [hash]);
  }
  configKeys(appId: number): string[] {
    return this.db
      .query<{ key: string }, [number]>(
        "SELECT key FROM config WHERE app_id = ? ORDER BY key",
      )
      .all(appId)
      .map((row) => row.key);
  }
}
