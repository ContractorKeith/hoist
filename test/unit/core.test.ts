import { expect, test } from "bun:test";
import { FakeCaddy } from "../../src/adapters/fakes/caddy";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import type { CaddyAdmin, DockerClient } from "../../src/adapters/interfaces";
import { nextReleaseNumber } from "../../src/core/releases";

test("next release number reads only the requested app and branch through the store seam", () => {
  const store = new FakeStore();
  expect(nextReleaseNumber(store, 1, "main")).toBe(1);
  store.releasesSeed.push(
    { appId: 1, branch: "main", number: 3 },
    { appId: 1, branch: "feature", number: 8 },
    { appId: 2, branch: "main", number: 9 },
  );
  expect(nextReleaseNumber(store, 1, "main")).toBe(4);
  expect(nextReleaseNumber(store, 1, "feature")).toBe(9);
  expect(store.calls).toEqual([
    { appId: 1, branch: "main" },
    { appId: 1, branch: "main" },
    { appId: 1, branch: "feature" },
  ]);
});

test("in-memory adapters implement the typed seams and record calls", async () => {
  const fakeDocker = new FakeDocker();
  const docker: DockerClient = fakeDocker;
  const fakeCaddy = new FakeCaddy();
  const caddy: CaddyAdmin = fakeCaddy;
  const signal = new AbortController().signal;
  const labels = { "hoist.test": "unit" };
  await docker.ping();
  expect(
    await new Response(
      await docker.buildImage(
        {
          contextDir: "/fixture",
          tag: "hoist/hello:unit",
          labels,
        },
        signal,
      ),
    ).text(),
  ).toContain("built");
  const id = await docker.createContainer({
    image: "hoist/hello:unit",
    labels,
    port: 8080,
    publishPort: 18080,
  });
  await docker.startContainer(id);
  expect(await docker.listContainers(labels)).toHaveLength(1);
  expect(
    await new Response(await docker.containerLogs(id, true, signal)).text(),
  ).toContain("hello");
  expect(
    fakeDocker.calls.find((call) => call.method === "containerLogs")?.args[2],
  ).toBe(signal);
  expect(
    fakeDocker.calls.find((call) => call.method === "buildImage")?.args[1],
  ).toBe(signal);
  await caddy.loadConfig({});
  await caddy.upsertRoute("hello.test", "127.0.0.1:18080");
  expect(fakeCaddy.routes.get("hello.test")).toBe("127.0.0.1:18080");
  await caddy.removeRoute("hello.test");
  await docker.stopContainer(id);
  await docker.removeContainer(id);
  await docker.removeImage("hoist/hello:unit");
  expect(await docker.listContainers(labels)).toEqual([]);
  expect(await docker.listImages(labels)).toEqual([]);
  expect(fakeDocker.calls.map((call) => call.method)).toContain(
    "startContainer",
  );
  expect(fakeCaddy.calls.map((call) => call.method)).toEqual([
    "loadConfig",
    "upsertRoute",
    "removeRoute",
  ]);
});
