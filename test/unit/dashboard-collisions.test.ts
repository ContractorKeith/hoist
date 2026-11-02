import { expect, test } from "bun:test";
import { FakeCaddy } from "../../src/adapters/fakes/caddy";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { caddyConfig } from "../../src/core/caddy-config";
import { reconcile } from "../../src/core/reconcile";

const dashboard = { host: "hoist.example.test", upstream: "127.0.0.1:8700" };
const settings = {
  adminPort: 2019,
  httpPort: 80,
  httpsPort: 443,
  tls: "internal" as const,
  dataDir: "/private",
};
const locks = {
  async withLock<T>(_name: string, run: () => Promise<T>) {
    return run();
  },
  isLocked: () => false,
};
function legacy() {
  const store = new FakeStore(),
    app = store.createApp("legacy", dashboard.host, "/");
  const release = store.insertRelease({
    app_id: app.id,
    branch: "main",
    number: 1,
    git_sha: "a".repeat(40),
    image: "image",
    config_json: "{}",
    status: "live",
  });
  return { store, app, release };
}
test("dashboard config suppresses colliding app routes even with positive release ids", async () => {
  const { app, release } = legacy(),
    caddy = new FakeCaddy(),
    messages: string[] = [];
  await caddy.loadConfig(
    caddyConfig(
      settings,
      [
        {
          host: app.domain,
          upstream: "127.0.0.1:9999",
          releaseId: release.id,
          appName: app.name,
        },
      ],
      dashboard,
      (message) => messages.push(message),
    ),
  );
  expect(caddy.routes.get(dashboard.host)).toBe(dashboard.upstream);
  expect(messages).toEqual([
    `app legacy host ${dashboard.host} collides with the dashboard; route suppressed`,
  ]);
});
test("reconcile never writes or removes an app route on the dashboard host, including recovery", async () => {
  const { store } = legacy(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy(),
    messages: string[] = [];
  await reconcile(
    store,
    docker,
    caddy,
    locks,
    async () => {},
    undefined,
    (message) => messages.push(message),
    undefined,
    dashboard,
  );
  expect(caddy.calls).toEqual([
    { method: "upsertRoute", args: [dashboard.host, dashboard.upstream] },
  ]);
  expect(docker.calls.some((call) => call.method === "createContainer")).toBe(
    false,
  );
  expect(messages).toEqual([
    `app legacy host ${dashboard.host} collides with the dashboard; route suppressed`,
  ]);
});

test("supervisor boot routes suppress legacy app and preview collisions once per app", async () => {
  const { bootRoutes } = await import("../../src/core/boot-routes");
  const { store, app } = legacy(),
    docker = new FakeDocker(),
    messages: string[] = [];
  store.insertRelease({
    app_id: app.id,
    branch: "main",
    number: 2,
    git_sha: "b".repeat(40),
    image: "image",
    config_json: "{}",
    status: "live",
  });
  const base = store.createApp("base", "example.test", "/");
  store.insertRelease({
    app_id: base.id,
    branch: "hoist",
    number: 1,
    git_sha: "c".repeat(40),
    image: "image",
    config_json: "{}",
    status: "live",
  });
  expect(
    await bootRoutes(store, docker, dashboard, (message) =>
      messages.push(message),
    ),
  ).toEqual([]);
  expect(docker.calls).toEqual([]);
  expect(messages.sort()).toEqual([
    `app base host ${dashboard.host} collides with the dashboard; route suppressed`,
    `app legacy host ${dashboard.host} collides with the dashboard; route suppressed`,
  ]);
});

test("a cutover cannot restore a suppressed legacy app route", async () => {
  const { cutover } = await import("../../src/core/cutover");
  const prior = process.env.HOIST_DASHBOARD_HOST;
  process.env.HOIST_DASHBOARD_HOST = dashboard.host;
  try {
    const { store, app } = legacy(),
      docker = new FakeDocker(),
      caddy = new FakeCaddy();
    const release = store.insertRelease({
      app_id: app.id,
      branch: "main",
      number: 2,
      git_sha: "b".repeat(40),
      image: "image",
      config_json: "{}",
      status: "built",
    });
    await expect(
      cutover(
        store,
        docker,
        caddy,
        app,
        release,
        null,
        async () => null,
        async () => {},
      ),
    ).rejects.toThrow(`host ${dashboard.host} is reserved for the dashboard`);
    expect(caddy.calls).toEqual([]);
    expect(docker.calls).toEqual([]);
  } finally {
    if (prior === undefined) delete process.env.HOIST_DASHBOARD_HOST;
    else process.env.HOIST_DASHBOARD_HOST = prior;
  }
});
