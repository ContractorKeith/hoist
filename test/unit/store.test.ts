import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaVersion } from "../../src/store/migrations";
import { SqliteStore } from "../../src/store/sqlite";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
function open(): SqliteStore {
  const dir = mkdtempSync(join(tmpdir(), "hoist-unit-"));
  dirs.push(dir);
  const store = new SqliteStore(join(dir, "data"));
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
  expect(
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all(),
  ).toEqual(
    ["apps", "config", "previews", "releases", "sessions"].map((name) => ({
      name,
    })),
  );
});

test("re-running migrations preserves schema and data", () => {
  const store = open();
  store.db.run(
    "INSERT INTO apps (name, domain) VALUES ('hello', 'hello.example.test')",
  );
  const before = store.db
    .query("SELECT * FROM sqlite_master ORDER BY name")
    .all();
  store.migrate();
  expect(
    store.db.query("SELECT * FROM sqlite_master ORDER BY name").all(),
  ).toEqual(before);
  expect(store.db.query("SELECT name FROM apps").all()).toEqual([
    { name: "hello" },
  ]);
  expect(store.db.query("PRAGMA user_version").get()).toEqual({
    user_version: schemaVersion,
  });
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
  expect(() => insert.run(99, "main", 1)).toThrow();
});
