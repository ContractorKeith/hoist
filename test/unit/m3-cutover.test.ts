import { expect, test } from "bun:test";
import { FakeCaddy } from "../../src/adapters/fakes/caddy";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { configCommand } from "../../src/cli/config";
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
