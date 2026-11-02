import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { type DoctorResult, doctor } from "../../src/cli/doctor";
import { type Check, doctorChecks } from "../../src/cli/doctor-checks";

test("corrupt database reports its file path, skips store checks and exits 1", async () => {
  const root = await mkdtemp(join(tmpdir(), "corrupt-doctor-"));
  const previous = process.env.HOIST_DIR;
  const output = spyOn(console, "log").mockImplementation(() => {});
  let storeChecks = 0,
    unrelatedChecks = 0;
  try {
    process.env.HOIST_DIR = root;
    await Bun.write(
      join(root, "hoist.db"),
      crypto.getRandomValues(new Uint8Array(512)),
    );
    const dependent = [
      "Secret key",
      "Serve lease",
      "Orphan containers",
      "Orphan images",
      "Orphan routes",
      "Dashboard password",
    ];
    const code = await doctor(["doctor", "--json"], (directory, source) => {
      const checks = doctorChecks(directory, source, new FakeDocker());
      const selected: Record<string, Check> = {
        Database: checks.Database as Check,
      };
      for (const name of dependent)
        selected[name] = () => {
          storeChecks++;
          return checks[name]?.();
        };
      selected.Unrelated = () => {
        unrelatedChecks++;
      };
      return selected;
    });
    expect(code).toBe(1);
    const rows = JSON.parse(
      String(output.mock.calls[0]?.[0]),
    ) as DoctorResult[];
    expect(rows[0]).toEqual({
      check: "Database",
      status: "error",
      message: `${join(root, "hoist.db")} is not a SQLite database; restore it from your backup.`,
    });
    for (const name of dependent)
      expect(rows.find((row) => row.check === name)).toEqual({
        check: name,
        status: "warning",
        message: "Skipped until the database check passes.",
      });
    expect(storeChecks).toBe(0);
    expect(unrelatedChecks).toBe(1);
  } finally {
    output.mockRestore();
    if (previous === undefined) delete process.env.HOIST_DIR;
    else process.env.HOIST_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
