import { expect, test } from "bun:test";
import { FakeCaddy } from "../../src/adapters/fakes/caddy";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { reserveRelease } from "../../src/core/build";
import { caddyConfig } from "../../src/core/caddy-config";
import { reconcile } from "../../src/core/reconcile";
import { eligibleReleases } from "../../src/web/actions";

const locks = {
  async withLock<T>(_name: string, run: () => Promise<T>) {
    return run();
  },
  isLocked: () => false,
};
test("full Caddy config and reconcile preserve the dashboard route without apps", async () => {
  const dashboard = { host: "hoist.example.test", upstream: "127.0.0.1:8700" };
  const config = JSON.stringify(
    caddyConfig(
      {
        adminPort: 2019,
        httpPort: 80,
        httpsPort: 443,
        tls: "internal",
        dataDir: "/private",
      },
      [],
      dashboard,
    ),
  );
  expect(config).toContain(dashboard.host);
  expect(config).toContain(dashboard.upstream);
  const caddy = new FakeCaddy();
  expect(
    await reconcile(
      new FakeStore(),
      new FakeDocker(),
      caddy,
      locks,
      async () => {},
      undefined,
      () => {},
      undefined,
      dashboard,
    ),
  ).toEqual([]);
  expect(caddy.calls).toContainEqual({
    method: "upsertRoute",
    args: [dashboard.host, dashboard.upstream],
  });
});
test("rollback choices use the configured main branch, require live and exclude absent images", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker(),
    app = store.createApp("hello", "hello.test", "/");
  const main = reserveRelease(store, app, "main", "a".repeat(40));
  store.completeRelease(main.id);
  expect(await eligibleReleases(store, docker, app)).toEqual([]);
  store.setReleaseState(main.id, "live", "a".repeat(64));
  const older = reserveRelease(store, app, "main", "b".repeat(40));
  store.completeRelease(older.id);
  const preview = reserveRelease(store, app, "feature", "c".repeat(40));
  store.completeRelease(preview.id);
  expect(
    (await eligibleReleases(store, docker, app)).map((row) => row.id),
  ).toEqual([older.id]);
  docker.imagePorts = async () => {
    throw new Error("404");
  };
  expect(await eligibleReleases(store, docker, app)).toEqual([]);
});
