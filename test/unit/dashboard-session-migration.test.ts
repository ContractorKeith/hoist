import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardStore } from "../../src/store/dashboard";
import { migrations } from "../../src/store/migrations";
import { SqliteStore } from "../../src/store/sqlite";
import { createSession, hashToken } from "../../src/web/auth";
import { setup } from "./dashboard-support";

test("migration 7 preserves the owner password and revokes unversioned sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "dashboard-migration-"));
  try {
    const old = new Database(join(root, "hoist.db"));
    for (const migration of migrations.slice(0, 6)) old.exec(migration);
    old.exec("PRAGMA user_version = 6");
    old.run("INSERT INTO settings VALUES ('owner_password', 'existing hash')");
    old.run(
      "INSERT INTO sessions VALUES ('legacy token hash', '9999-01-01T00:00:00.000Z')",
    );
    old.close();
    const store = new SqliteStore(root);
    try {
      const db = new DashboardStore(store.db);
      expect(db.credentials()?.hash).toBe("existing hash");
      expect(db.credentials()?.version).toBeTruthy();
      expect(store.db.query("SELECT * FROM sessions").all()).toEqual([]);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("session insertion rejects a credential snapshot replaced after verification", async () => {
  const h = await setup();
  try {
    const old = h.db.credentials();
    if (!old) throw new Error("Missing fixture password");
    const token = createSession(h.db);
    h.db.savePassword(old.hash);
    expect(
      h.db.createSession(hashToken(token), "9999-01-01T00:00:00.000Z", old),
    ).toBe(false);
    expect(h.store.db.query("SELECT * FROM sessions").all()).toEqual([]);
  } finally {
    await h.close();
  }
});
