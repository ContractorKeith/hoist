import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorChecks } from "../../src/cli/doctor";
import { schemaVersion } from "../../src/store/migrations";
import { SqliteStore } from "../../src/store/sqlite";

for (const kind of ["corrupt", "readonly", "newer"]) {
  test(`store and doctor explain ${kind} database with a remedy`, async () => {
    const root = await mkdtemp(join(tmpdir(), "store-errors-"));
    const path = join(root, "hoist.db");
    try {
      let message: string;
      if (kind === "corrupt") {
        await Bun.write(path, "not sqlite".repeat(100));
        message = `${path} is not a SQLite database; restore it from your backup.`;
      } else if (kind === "newer") {
        const db = new Database(path, { create: true });
        db.exec("PRAGMA user_version = 99");
        db.close();
        message = `Database schema version 99 is newer than this hoist (${schemaVersion}); upgrade hoist.`;
      } else {
        new SqliteStore(root).close();
        await chmod(root, 0o500);
        message = `${root} is read-only; fix its mode and owner.`;
      }
      expect(() => new SqliteStore(root)).toThrow(message);
      const checks = doctorChecks(root, () => new SqliteStore(root));
      expect(() => checks.Database?.()).toThrow(message);
    } finally {
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });
}
