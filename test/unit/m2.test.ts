import { expect, test } from "bun:test";
import { FakeCaddy } from "../../src/adapters/fakes/caddy";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { destroyApp } from "../../src/core/apps";
import { reserveRelease } from "../../src/core/build";
import { type CaddySettings, caddyConfig } from "../../src/core/caddy-config";
import { appPort, cutover, type HealthCheck } from "../../src/core/cutover";
import { healthyStatus, pollHealth } from "../../src/core/health";
import { reconcile } from "../../src/core/reconcile";

const sha = "a".repeat(40);
const settings: CaddySettings = {
  adminPort: 2019,
  httpPort: 8081,
  httpsPort: 8443,
  tls: "internal",
  dataDir: "/private/hoist",
};
function setup() {
  const store = new FakeStore(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy();
  const app = store.createApp("hello", "hello.test", "/ready");
  const release = reserveRelease(store, app, "main", sha);
  store.completeRelease(release.id);
  const run = (
    health: HealthCheck = async () => {},
    head = async (): Promise<string | null> => sha,
  ) => cutover(store, docker, caddy, app, release, head, health);
  return { store, docker, caddy, app, release, run };
}

test("cutover starts, checks health, swaps, then stops old and commits statuses", async () => {
  const { store, docker, caddy, app, release, run } = setup();
  const old = store.insertRelease({ ...release, number: 0, status: "live" });
  const id = await docker.createContainer({
    image: old.image,
    port: 8080,
    publishPort: "",
    labels: { "hoist.app": app.name },
  });
  await docker.startContainer(id);
  store.setReleaseState(old.id, "live", id);
  const order: string[] = [];
  const swap = caddy.upsertRoute.bind(caddy),
    stop = docker.stopContainer.bind(docker);
  caddy.upsertRoute = async (...args) => {
    order.push("swap");
    await swap(...args);
  };
  docker.stopContainer = async (...args) => {
    expect(order).toEqual(["health", "swap"]);
    order.push("stop");
    await stop(...args);
  };
  await run(async (port, path) => {
    expect(port).toBeGreaterThan(0);
    expect(path).toBe("/ready");
    expect(docker.running.size).toBe(2);
    order.push("health");
  });
  expect(order).toEqual(["health", "swap", "stop"]);
  expect(old.status).toBe("stopped");
  expect(release.status).toBe("live");
  expect(docker.containers.has(id)).toBe(false);
  const spec = docker.calls.find(
    (call) =>
      call.method === "createContainer" &&
      (call.args[0] as { labels: Record<string, string> }).labels[
        "hoist.release"
      ],
  );
  expect(spec?.args[0]).toMatchObject({
    publishPort: "",
    port: 8080,
    config: {},
    labels: {
      "hoist.app": "hello",
      "hoist.branch": "main",
      "hoist.release": String(release.id),
    },
  });
});

test("failed health check leaves old live, never touches Caddy and removes candidate", async () => {
  const { store, docker, caddy, release, run } = setup();
  const old = store.insertRelease({ ...release, number: 0, status: "live" });
  await expect(
    run(async () => {
      throw new Error("HTTP 500");
    }),
  ).rejects.toThrow("HTTP 500");
  expect(release.status).toBe("failed");
  expect(old.status).toBe("live");
  expect(caddy.calls).toEqual([]);
  expect(docker.containers.size).toBe(0);
});

test("stale branch tip fails before touching Docker or Caddy", async () => {
  const { docker, caddy, release, run } = setup();
  await expect(run(undefined, async () => "b".repeat(40))).rejects.toThrow(
    "branch main tip is bbbbbbbbbbbb, not this release; skipping cutover",
  );
  expect(release.status).toBe("failed");
  expect(docker.calls).toEqual([]);
  expect(caddy.calls).toEqual([]);
});

test("unreachable Caddy fails the candidate and keeps previous live", async () => {
  const { store, docker, caddy, release, run } = setup();
  const old = store.insertRelease({ ...release, number: 0, status: "live" });
  caddy.upsertRoute = async () => {
    throw new Error("Caddy unavailable");
  };
  await expect(run()).rejects.toThrow("Caddy unavailable");
  expect(old.status).toBe("live");
  expect(release.status).toBe("failed");
  expect(docker.containers.size).toBe(0);
});

test("container start failure removes the created container", async () => {
  const { docker, release, run } = setup();
  docker.startContainer = async () => {
    throw new Error("start failed");
  };
  await expect(run()).rejects.toThrow("start failed");
  expect(release.status).toBe("failed");
  expect(docker.containers.size).toBe(0);
});

test("port selection uses one exposed TCP port, otherwise PORT or 8080", () => {
  expect(appPort([80], { PORT: "3000" })).toBe(80);
  expect(appPort([], {})).toBe(8080);
  expect(appPort([80, 443], { PORT: "3000" })).toBe(3000);
  for (const value of ["0", "65536", "x", "2.5"])
    expect(() => appPort([], { PORT: value })).toThrow("Invalid app port");
  for (const status of [200, 204, 301, 399])
    expect(healthyStatus(status)).toBe(true);
  for (const status of [199, 400, 500])
    expect(healthyStatus(status)).toBe(false);
});

for (const tls of ["internal", "acme"] as const) {
  for (const count of [0, 1, 3])
    test(`Caddy config ${tls}, ${count} routes`, () => {
      const routes = Array.from({ length: count }, (_, i) => ({
        host: `app${i}.test`,
        upstream: `127.0.0.1:${30000 + i}`,
      }));
      const config = caddyConfig(
        { ...settings, tls, email: "owner@example.test" },
        routes,
      );
      expect(config).toMatchObject({
        admin: { listen: "127.0.0.1:2019" },
        storage: { root: "/private/hoist/caddy" },
        apps: {
          http: {
            http_port: 8081,
            https_port: 8443,
            servers: {
              hoist: {
                listen: [":8443"],
                routes: routes.map((item) => ({
                  "@id": `hoist-${item.host}`,
                  match: [{ host: [item.host] }],
                  handle: [
                    {
                      handler: "reverse_proxy",
                      upstreams: [{ dial: item.upstream }],
                    },
                  ],
                  terminal: true,
                })),
              },
            },
          },
          tls: {
            automation: {
              policies: [
                {
                  issuers: [
                    tls === "internal"
                      ? { module: "internal" }
                      : {
                          module: "acme",
                          ca: "https://acme-v02.api.letsencrypt.org/directory",
                          email: "owner@example.test",
                        },
                  ],
                },
              ],
            },
          },
        },
      });
    });
}

test("reconcile fails stale building releases, removes images, restores missing live and removes orphans", async () => {
  const { store, docker, caddy, app, release } = setup();
  store.setReleaseState(release.id, "live", "f".repeat(64));
  const stale = reserveRelease(store, app, "main", "b".repeat(40));
  docker.images.set(stale.image, {
    "hoist.app": app.name,
    "hoist.release": String(stale.id),
  });
  const orphan = await docker.createContainer({
    image: release.image,
    labels: { "hoist.app": app.name },
    port: 8080,
    publishPort: "",
  });
  await reconcile(store, docker, caddy, settings, async () => {});
  expect(stale.status).toBe("failed");
  expect(docker.images.size).toBe(0);
  expect(release.status).toBe("live");
  expect(release.container_id).not.toBe("f".repeat(64));
  expect(docker.containers.has(orphan)).toBe(false);
  expect(docker.containers.size).toBe(1);
  expect(caddy.calls.at(-1)?.method).toBe("loadConfig");
});

test("reconcile keeps a running live container and replaces a stopped one without stopping the live row", async () => {
  const { store, docker, caddy, release, run } = setup();
  await run();
  const id = release.container_id ?? "";
  docker.calls.length = 0;
  await reconcile(store, docker, caddy, settings, async () => {});
  expect(docker.calls.some((call) => call.method === "createContainer")).toBe(
    false,
  );
  expect(release.container_id).toBe(id);
  await docker.stopContainer(id);
  await reconcile(store, docker, caddy, settings, async () => {});
  expect(release.container_id).not.toBe(id);
  expect(docker.containers.has(id)).toBe(false);
});

test("destroy removes route, containers, images, files then rows", async () => {
  const { store, docker, caddy, app, run } = setup();
  await run();
  docker.images.set("hoist/hello:test", { "hoist.app": app.name });
  await destroyApp(
    store,
    docker,
    app,
    async () => {
      expect(docker.containers.size).toBe(0);
      expect(docker.images.size).toBe(0);
      expect(caddy.routes.size).toBe(0);
    },
    caddy,
  );
  expect(store.apps()).toEqual([]);
});

test("reconcile preserves builds created after process start", async () => {
  const { store, docker, caddy, app } = setup();
  const row = reserveRelease(store, app, "main", "d".repeat(40));
  row.created_at = "2030-01-01T00:00:00.000Z";
  await reconcile(
    store,
    docker,
    caddy,
    settings,
    async () => {},
    "2026-11-01T00:00:00.000Z",
  );
  expect(row.status).toBe("building");
});

test("failed boot recovery preserves the live row for a retry and removes its candidate", async () => {
  const { store, docker, caddy, release } = setup();
  store.setReleaseState(release.id, "live");
  await expect(
    reconcile(store, docker, caddy, settings, async () => {
      throw new Error("HTTP 500");
    }),
  ).rejects.toThrow("HTTP 500");
  expect(release.status).toBe("live");
  expect(docker.containers.size).toBe(0);
  expect(caddy.calls).toEqual([]);
});

test("destroy re-lists images because removing a leaf can reveal a labelled parent", async () => {
  const { store, docker, caddy, app } = setup();
  let remaining = 3;
  docker.listImages = async () =>
    remaining ? [`hoist/hello:layer${remaining}`] : [];
  docker.removeImage = async () => {
    remaining--;
  };
  await destroyApp(store, docker, app, async () => {}, caddy);
  expect(remaining).toBe(0);
  expect(store.apps()).toEqual([]);
});

test("health polls every 500 ms and accepts a redirect without following it", async () => {
  let now = 0,
    calls = 0;
  const sleeps: number[] = [];
  await pollHealth("/ready", async () => (++calls === 1 ? 500 : 302), {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  expect(calls).toBe(2);
  expect(sleeps).toEqual([500]);
});

test("health fails after 30 s with the final HTTP output", async () => {
  let now = 0,
    calls = 0;
  await expect(
    pollHealth(
      "/ready",
      async () => {
        calls++;
        return 500;
      },
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    ),
  ).rejects.toThrow("Health check GET /ready failed after 30 s: HTTP 500");
  expect(now).toBe(30000);
  expect(calls).toBe(60);
});
