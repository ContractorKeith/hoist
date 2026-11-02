import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations, schemaVersion } from "../../src/store/migrations";
import { SqliteStore } from "../../src/store/sqlite";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
function dataDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "hoist-unit-"));
  dirs.push(dir);
  return join(dir, "data");
}
function open(dir = dataDirectory()): SqliteStore {
  const store = new SqliteStore(dir);
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("fresh data directory migrates to the recorded current schema in WAL mode", () => {
  const { db } = open();
  expect(db.query("PRAGMA user_version").get()).toEqual({
    user_version: schemaVersion,
  });
  expect(db.query("PRAGMA journal_mode").get()).toEqual({
    journal_mode: "wal",
  });
  expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  expect(
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all(),
  ).toEqual(
    [
      "apps",
      "config",
      "locks",
      "previews",
      "releases",
      "sessions",
      "settings",
    ].map((name) => ({
      name,
    })),
  );
});

test("reopening the store preserves schema and data", () => {
  const dir = dataDirectory();
  const store = open(dir);
  store.db.run(
    "INSERT INTO apps (name, domain) VALUES ('hello', 'hello.example.test')",
  );
  const before = store.db
    .query("SELECT * FROM sqlite_master ORDER BY name")
    .all();
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = open(dir);
  expect(
    reopened.db.query("SELECT * FROM sqlite_master ORDER BY name").all(),
  ).toEqual(before);
  expect(reopened.db.query("SELECT name FROM apps").all()).toEqual([
    { name: "hello" },
  ]);
  expect(reopened.db.query("PRAGMA user_version").get()).toEqual({
    user_version: schemaVersion,
  });
});

test("opening a newer schema fails", () => {
  const dir = dataDirectory();
  const store = open(dir);
  store.db.exec(`PRAGMA user_version = ${schemaVersion + 1}`);
  store.close();
  stores.splice(stores.indexOf(store), 1);
  expect(() => new SqliteStore(dir)).toThrow("newer than this hoist");
});

test("release numbers are isolated by app and branch; snapshots cannot be changed", () => {
  const store = open();
  store.db.run(
    "INSERT INTO apps (id, name, domain) VALUES (1, 'hello', 'hello.test'), (2, 'other', 'other.test')",
  );
  const insert = store.db.query(
    "INSERT INTO releases (app_id, branch, number, git_sha, image, config_json, status) VALUES (?, ?, ?, 'abc', 'hoist/hello:abc', '{}', 'building')",
  );
  insert.run(1, "main", 1);
  insert.run(1, "main", 2);
  insert.run(1, "feature", 1);
  insert.run(2, "main", 7);
  expect(store.latestReleaseNumber(1, "main")).toBe(2);
  expect(store.latestReleaseNumber(1, "feature")).toBe(1);
  expect(store.latestReleaseNumber(1, "missing")).toBe(0);
  expect(() => insert.run(1, "main", 2)).toThrow();
  expect(() => store.db.run("UPDATE releases SET image = 'other'")).toThrow(
    "immutable",
  );
  expect(() => store.db.run("UPDATE releases SET config_json = '{}'")).toThrow(
    "immutable",
  );
  expect(() =>
    store.db.run("UPDATE releases SET status = 'live'"),
  ).not.toThrow();
  expect(() =>
    store.db.run("UPDATE releases SET container_id = 'abc'"),
  ).not.toThrow();
  expect(
    store.db.query("SELECT DISTINCT status, container_id FROM releases").all(),
  ).toEqual([{ status: "live", container_id: "abc" }]);
  expect(() => insert.run(99, "main", 1)).toThrow();
});

test("migration 2 preserves M0 releases, adds built and keeps immutable snapshots and cascade", () => {
  const dir = dataDirectory();
  // Create the exact M0 schema before opening the current store.
  mkdirSync(dir, { recursive: true });
  const legacy = new Database(join(dir, "hoist.db"), { create: true });
  legacy.exec(migrations[0]);
  legacy.exec(
    "PRAGMA user_version = 1; INSERT INTO apps (id, name, domain) VALUES (1, 'hello', 'hello.test'); INSERT INTO releases (app_id, branch, number, git_sha, image, config_json, status) VALUES (1, 'main', 1, 'abc', 'hoist/hello:abc', '{}', 'building');",
  );
  const before = legacy.query("SELECT * FROM releases").all();
  legacy.close();
  const store = open(dir);
  expect(store.db.query("SELECT * FROM releases").all()).toEqual(
    before.map((row) => ({ ...(row as object), pruned_at: null })),
  );
  store.completeRelease(1);
  expect(store.releases(1)[0]?.status).toBe("built");
  expect(() => store.db.run("UPDATE releases SET status = 'bogus'")).toThrow();
  expect(() => store.db.run("UPDATE releases SET image = 'changed'")).toThrow(
    "immutable",
  );
  expect(() =>
    store.db.run("UPDATE releases SET config_json = 'changed'"),
  ).toThrow("immutable");
  store.deleteApp(1);
  expect(store.releases(1)).toEqual([]);
});

test("release status transitions reject deleted rows", () => {
  const store = open();
  const app = store.createApp("hello", "hello.test", "/");
  const row = store.insertRelease({
    app_id: app.id,
    branch: "main",
    number: 1,
    git_sha: "abc",
    image: "hoist/hello:abc",
    config_json: "{}",
    status: "building",
  });
  store.deleteApp(app.id);
  expect(() => store.completeRelease(row.id)).toThrow(
    `release ${row.id} no longer exists`,
  );
  expect(() => store.failRelease(row.id)).toThrow(
    `release ${row.id} no longer exists`,
  );
});
