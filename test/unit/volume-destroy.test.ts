import { expect, test } from "bun:test";
import { FakeCaddy } from "../../src/adapters/fakes/caddy";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { parseCli } from "../../src/cli/apps";
import { createApp, destroyApp } from "../../src/core/apps";
import { productionVolume } from "../../src/core/volumes";

test("destroy keeps an app with a volume unless --delete-volume is passed", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy();
  const noop = async () => {};
  const app = await createApp(
    store,
    "app",
    "app.test",
    "/",
    noop,
    noop,
    "/data",
  );
  await productionVolume(docker, app, "main");
  expect(parseCli(["apps:destroy", "app", "--force"]).deleteVolume).toBe(false);
  expect(
    parseCli(["apps:destroy", "app", "--delete-volume"]).deleteVolume,
  ).toBe(true);
  await expect(destroyApp(store, docker, app, noop, caddy)).rejects.toThrow(
    "--delete-volume",
  );
  expect(store.app("app")).not.toBeNull();
  expect(docker.volumes.has("hoist-app-data")).toBe(true);
  const warnings: string[] = [];
  await destroyApp(
    store,
    docker,
    app,
    noop,
    caddy,
    (m) => warnings.push(m),
    true,
  );
  expect(store.app("app")).toBeNull();
  expect(docker.volumes.has("hoist-app-data")).toBe(false);
  expect(warnings.join()).toContain("Destroying volume hoist-app-data");
});
