import { expect, test } from "bun:test";
import { FakeCaddy } from "../../src/adapters/fakes/caddy";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { configCommand } from "../../src/cli/config";
import { bootRoutes } from "../../src/core/boot-routes";
import { reserveRelease } from "../../src/core/build";
import { cutover, recoverLive } from "../../src/core/cutover";

test("cutover and recovery inject the encrypted snapshot, never current config", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy();
  const app = store.createApp("hello", "hello.test", "/");
  await configCommand(
    store,
    ["config:set", "hello", "PORT=9090", "A=snapshot"],
    () => {},
  );
  const release = reserveRelease(store, app, "main", "a".repeat(40));
  store.completeRelease(release.id);
  await configCommand(store, ["config:set", "hello", "A=current"], () => {});
  const lines: string[] = [];
  const health = async () => {};
  await cutover(
    store,
    docker,
    caddy,
    app,
    release,
    null,
    async () => null,
    health,
    async (line) => {
      lines.push(line);
    },
  );
  expect(
    docker.calls.find((call) => call.method === "createContainer")?.args[0],
  ).toMatchObject({ config: { A: "snapshot", PORT: "9090" } });
  expect(lines.join("\n")).not.toContain("snapshot");
  await recoverLive(store, docker, caddy, app, release, health);
  expect(
    docker.calls.findLast((call) => call.method === "createContainer")?.args[0],
  ).toMatchObject({ config: { A: "snapshot", PORT: "9090" } });
});

test("wrong config key fails the candidate before creating a container", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy();
  const app = store.createApp("hello", "hello.test", "/");
  await configCommand(
    store,
    ["config:set", "hello", "A=private-value"],
    () => {},
  );
  const release = reserveRelease(store, app, "main", "a".repeat(40));
  store.completeRelease(release.id);
  const wrongKey = await new FakeStore().secretKey();
  store.secretKey = async () => wrongKey;
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
  ).rejects.toThrow("Cannot decrypt config;");
  expect(release.status).toBe("failed");
  expect(docker.calls.some((call) => call.method === "createContainer")).toBe(
    false,
  );
});

test("cutover refuses existing damaged config even when its own snapshot decrypts", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy();
  const app = store.createApp("hello", "hello.test", "/");
  await configCommand(store, ["config:set", "hello", "A=valid"], () => {});
  const release = reserveRelease(store, app, "main", "a".repeat(40));
  store.completeRelease(release.id);
  store.setConfig(app.id, "B", "v1:damaged:ciphertext");
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
  ).rejects.toThrow("Cannot decrypt config;");
  expect(release.status).toBe("failed");
  expect(docker.calls.some((call) => call.method === "createContainer")).toBe(
    false,
  );
});

test("Caddy rebuild during old-container stop routes to the committed new release", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy();
  const app = store.createApp("hello", "hello.test", "/");
  const old = reserveRelease(store, app, "main", "a".repeat(40));
  store.completeRelease(old.id);
  const run = (release: typeof old) =>
    cutover(
      store,
      docker,
      caddy,
      app,
      release,
      null,
      async () => null,
      async () => {},
    );
  await run(old);
  const oldId = old.container_id ?? "";
  const next = reserveRelease(store, app, "main", "b".repeat(40));
  store.completeRelease(next.id);
  const swap = caddy.upsertRoute.bind(caddy);
  caddy.upsertRoute = async (...args) => {
    await swap(...args);
    caddy.routes.clear();
  };
  const stop = docker.stopContainer.bind(docker);
  docker.stopContainer = async (id) => {
    const routes = await bootRoutes(
      store,
      docker,
      { host: "hoist.test", upstream: "127.0.0.1:8700" },
      () => {},
    );
    const info = await docker.inspectContainer(next.container_id ?? "");
    expect(routes).toMatchObject([
      {
        host: app.domain,
        upstream: `127.0.0.1:${info?.port}`,
        releaseId: next.id,
      },
    ]);
    for (const route of routes) await swap(route.host, route.upstream);
    await stop(id);
  };
  await run(next);
  expect(docker.containers.has(oldId)).toBe(false);
  expect(caddy.routes.get(app.domain)).toBe(
    `127.0.0.1:${(await docker.inspectContainer(next.container_id ?? ""))?.port}`,
  );
});

test("failed candidate removal appends cleanup detail without masking health failure", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy();
  const app = store.createApp("hello", "hello.test", "/");
  const release = reserveRelease(store, app, "main", "a".repeat(40));
  store.completeRelease(release.id);
  docker.removeContainer = async () => {
    throw new Error("Docker DELETE 404");
  };
  await expect(
    cutover(
      store,
      docker,
      caddy,
      app,
      release,
      null,
      async () => null,
      async () => {
        throw new Error("Health check HTTP 500");
      },
    ),
  ).rejects.toThrow("Health check HTTP 500; cleanup: Docker DELETE 404");
  expect(release.status).toBe("failed");
});
