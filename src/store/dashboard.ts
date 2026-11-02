import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export interface PasswordCredentials {
  hash: string;
  version: string;
}

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
  credentials(): PasswordCredentials | null {
    const row = this.db
      .query<{ hash: string | null; version: string | null }, []>(
        "SELECT (SELECT value FROM settings WHERE key = 'owner_password') AS hash, (SELECT value FROM settings WHERE key = 'password_version') AS version",
      )
      .get();
    return row?.hash && row.version
      ? { hash: row.hash, version: row.version }
      : null;
  }
  savePassword(hash: string): void {
    this.db
      .transaction(() => {
        this.db.run(
          "INSERT INTO settings VALUES ('owner_password', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [hash],
        );
        this.db.run(
          "INSERT INTO settings(key, value) VALUES ('password_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [randomUUID()],
        );
        this.db.run("DELETE FROM sessions");
      })
      .immediate();
  }
  createSession(
    hash: string,
    expires: string,
    expected?: PasswordCredentials,
  ): boolean {
    // Serialize the final credential check and insertion against password replacement.
    return this.db
      .transaction(() => {
        const current = this.credentials();
        if (
          !current ||
          (expected &&
            (current.hash !== expected.hash ||
              current.version !== expected.version))
        )
          return false;
        this.db.run("DELETE FROM sessions WHERE expires_at <= ?", [
          new Date().toISOString(),
        ]);
        this.db.run(
          "INSERT INTO sessions(token_hash, expires_at, password_version) VALUES (?, ?, ?)",
          [hash, expires, current.version],
        );
        return true;
      })
      .immediate();
  }
  session(hash: string, now: string): string | null {
    const row = this.db
      .query<{ expires_at: string; password_version: string }, [string]>(
        "SELECT expires_at, password_version FROM sessions WHERE token_hash = ?",
      )
      .get(hash);
    if (!row) return null;
    const expires = Date.parse(row.expires_at),
      time = Date.parse(now),
      credentials = this.credentials();
    if (
      !Number.isFinite(expires) ||
      !Number.isFinite(time) ||
      expires <= time ||
      !credentials ||
      row.password_version !== credentials.version
    ) {
      this.deleteSession(hash);
      return null;
    }
    return row.expires_at;
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
