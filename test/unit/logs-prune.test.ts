import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { reserveRelease } from "../../src/core/build";
import { releaseLogPath, removeReleaseLogs } from "../../src/core/logs";
import { prune } from "../../src/core/retention";

test("prune uses the protected log helper, removes stopped logs, and reports failures without throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoist-log-prune-"));
  try {
    const store = new FakeStore(),
      docker = new FakeDocker();
    const app = store.createApp("hello", "hello.test", "/");
    store.setRetention(app.id, 1);
    for (let number = 1; number <= 3; number++) {
      const row = reserveRelease(store, app, "main", "a".repeat(40));
      row.status = number === 3 ? "live" : "stopped";
      const path = releaseLogPath(root, app.name, row.branch, `v${number}`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "log\n");
    }
    const path = (number: number) =>
      dirname(releaseLogPath(root, app.name, "main", `v${number}`));
    await rm(path(2), { recursive: true });
    await symlink(root, path(2));
    const warnings: string[] = [];
    await expect(
      prune(
        store,
        docker,
        app,
        (row) =>
          removeReleaseLogs(root, app.name, row.branch, row.number, store),
        async (warning) => {
          warnings.push(warning);
        },
      ),
    ).resolves.toBeUndefined();
    expect(await stat(path(1)).catch(() => null)).toBeNull();
    expect((await stat(path(3))).isDirectory()).toBe(true);
    expect(store.releases(app.id)[0]?.pruned_at).toBeTruthy();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("releases/hello/main/v2");
    expect(warnings[0]).toContain("symlink");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
