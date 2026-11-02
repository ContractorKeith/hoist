import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations } from "../../src/store/migrations";
import { SqliteStore } from "../../src/store/sqlite";

test("pre-M5 release chains are backfilled as fresh, slugified previews during migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-migration-"));
  try {
    const db = new Database(join(root, "hoist.db"));
    for (const sql of migrations.slice(0, -1)) db.exec(sql);
    db.exec(`PRAGMA user_version = ${migrations.length - 1}`);
    db.run(
      "INSERT INTO apps(id, name, domain) VALUES (1, 'blog', 'blog.test')",
    );
    for (const branch of ["main", "feature", "Feature/X__Y"])
      db.run(
        "INSERT INTO releases(app_id, branch, number, git_sha, image, config_json, status, created_at) VALUES(1, ?, 1, ?, ?, '{}', 'live', '2020-01-01T00:00:00Z')",
        [branch, "a".repeat(40), `hoist/blog:${branch}`],
      );
    db.close();
    const before = Date.now();
    const store = new SqliteStore(root);
    try {
      expect(store.previews(1).map((p) => [p.branch, p.slug])).toEqual([
        ["Feature/X__Y", "feature-x-y"],
        ["feature", "feature"],
      ]);
      for (const preview of store.previews(1))
        expect(Date.parse(preview.last_push_at)).toBeGreaterThanOrEqual(before);
      expect(store.app("blog")?.main_branch).toBeNull();
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
