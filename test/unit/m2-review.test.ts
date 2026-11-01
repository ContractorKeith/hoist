import { expect, test } from "bun:test";
import { Caddy } from "../../src/adapters/caddy";
import { FakeCaddy } from "../../src/adapters/fakes/caddy";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { destroyApp } from "../../src/core/apps";
import { reserveRelease } from "../../src/core/build";

test("fake status writes cannot resurrect failed or fail live releases", () => {
  const store = new FakeStore();
  const app = store.createApp("hello", "hello.test", "/");
  const row = reserveRelease(store, app, "main", "a".repeat(40));
  store.failRelease(row.id);
  expect(() => store.completeRelease(row.id)).toThrow();
  const live = reserveRelease(store, app, "main", "b".repeat(40));
  store.completeRelease(live.id);
  store.setReleaseState(live.id, "live", "a".repeat(64));
  expect(() => store.failRelease(live.id)).toThrow();
  expect(live.status).toBe("live");
});

test("route update retries a concurrent ETag edit", async () => {
  let patches = 0,
    gets = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.method === "GET") {
        gets++;
        return Response.json([], { headers: { Etag: `"${gets}"` } });
      }
      patches++;
      return new Response(null, { status: patches === 1 ? 412 : 200 });
    },
  });
  try {
    await new Caddy(server.port).upsertRoute("hello.test", "127.0.0.1:8080");
    expect(patches).toBe(2);
    expect(gets).toBe(2);
  } finally {
    await server.stop(true);
  }
});

test("destroy succeeds with Caddy down after deleting local resources", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy();
  const app = store.createApp("hello", "hello.test", "/");
  caddy.removeRoute = async () => {
    expect(store.apps()).toEqual([]);
    throw new Error("Caddy admin API not reachable at http://127.0.0.1:2019");
  };
  await destroyApp(store, docker, app, async () => {}, caddy);
  expect(store.apps()).toEqual([]);
});

test("two file lock holders serialize and a dead pid is reclaimed", async () => {
  const { FileAppLocks } = await import("../../src/adapters/app-lock");
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "hoist-lock-"));
  try {
    const locks = new FileAppLocks(root),
      order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = locks.withLock("hello", async () => {
      order.push("first");
      await gate;
      order.push("released");
    });
    const second = locks.withLock("hello", async () => {
      order.push("second");
    });
    await Bun.sleep(220);
    expect(order).toEqual(["first"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "released", "second"]);
    expect(locks.isLocked("hello")).toBe(false);
    await mkdir(join(root, "locks"), { recursive: true });
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    await writeFile(join(root, "locks/hello.lock"), String(dead.pid));
    await locks.withLock("hello", async () => {
      expect(locks.isLocked("hello")).toBe(true);
    });
    expect(locks.isLocked("hello")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite status writes use compare-and-swap including recovery", async () => {
  const { SqliteStore } = await import("../../src/store/sqlite");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "hoist-cas-")),
    store = new SqliteStore(root);
  try {
    const app = store.createApp("hello", "hello.test", "/"),
      row = reserveRelease(store, app, "main", "a".repeat(40));
    expect(() =>
      store.setReleaseState(row.id, "live", "a".repeat(64)),
    ).toThrow();
    store.failRelease(row.id);
    expect(() => store.completeRelease(row.id)).toThrow();
    const live = reserveRelease(store, app, "main", "b".repeat(40));
    store.completeRelease(live.id);
    store.setReleaseState(live.id, "live", "a".repeat(64));
    expect(() =>
      store.setReleaseState(live.id, "live", "b".repeat(64)),
    ).toThrow();
    store.setReleaseState(live.id, "live", "b".repeat(64), "live");
    expect(() => store.failRelease(live.id)).toThrow();
    store.setReleaseState(live.id, "stopped");
    expect(() => store.failRelease(live.id)).toThrow();
    expect(
      store.releases(app.id).find((row) => row.id === live.id)?.status,
    ).toBe("stopped");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate hosts choose the newest release id regardless of input order", async () => {
  const { caddyConfig } = await import("../../src/core/caddy-config");
  const config = caddyConfig(
    {
      dataDir: "/private",
      tls: "internal",
      adminPort: 2019,
      httpPort: 80,
      httpsPort: 443,
    },
    [
      { host: "hello.test", upstream: "127.0.0.1:9002", releaseId: 2 },
      { host: "hello.test", upstream: "127.0.0.1:9001", releaseId: 1 },
    ],
  );
  expect(JSON.stringify(config).match(/hoist-hello.test/g)).toHaveLength(1);
  expect(JSON.stringify(config)).toContain("127.0.0.1:9002");
  expect(JSON.stringify(config)).not.toContain("127.0.0.1:9001");
});

test("reconcile isolates failed recovery and preserves in-flight release containers", async () => {
  const { reconcile } = await import("../../src/core/reconcile");
  const store = new FakeStore(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy();
  const bad = store.createApp("bad", "bad.test", "/"),
    good = store.createApp("good", "good.test", "/");
  const badRow = reserveRelease(store, bad, "main", "a".repeat(40));
  store.completeRelease(badRow.id);
  store.setReleaseState(badRow.id, "live");
  const row = reserveRelease(store, good, "main", "b".repeat(40));
  store.completeRelease(row.id);
  const id = await docker.createContainer({
    image: row.image,
    port: 8080,
    publishPort: "",
    labels: { "hoist.app": "good", "hoist.release": String(row.id) },
  });
  await docker.startContainer(id);
  store.setReleaseState(row.id, "live", id);
  const pending = reserveRelease(store, good, "main", "c".repeat(40));
  store.completeRelease(pending.id);
  const candidate = await docker.createContainer({
    image: pending.image,
    port: 8080,
    publishPort: "",
    labels: { "hoist.app": "good", "hoist.release": String(pending.id) },
  });
  await docker.startContainer(candidate);
  const locked = await docker.createContainer({
    image: row.image,
    port: 8080,
    publishPort: "",
    labels: { "hoist.app": "newapp" },
  });
  await docker.startContainer(locked);
  const acquired: string[] = [];
  const errors = await reconcile(
    store,
    docker,
    caddy,
    {
      dataDir: "/private",
      tls: "internal",
      adminPort: 2019,
      httpPort: 80,
      httpsPort: 443,
    },
    {
      withLock: async (name, action) => {
        acquired.push(name);
        return action();
      },
      isLocked: (name) => name === "newapp",
    },
    async () => {
      throw new Error("HTTP 500");
    },
    undefined,
    () => {},
  );
  expect(errors).toHaveLength(1);
  expect(acquired).toEqual(["bad", "good"]);
  expect(caddy.routes.has("good.test")).toBe(true);
  expect(docker.containers.has(candidate)).toBe(true);
  expect(docker.containers.has(locked)).toBe(true);
});

test("Caddy stops retrying after five ETag conflicts", async () => {
  let attempts = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.method === "GET")
        return Response.json([], { headers: { Etag: '"1"' } });
      attempts++;
      return new Response(null, { status: 412 });
    },
  });
  try {
    await expect(
      new Caddy(server.port).removeRoute("hello.test"),
    ).rejects.toThrow("after 5 attempts");
    expect(attempts).toBe(5);
  } finally {
    await server.stop(true);
  }
});

test("shutdown escalates to SIGKILL after the grace period", async () => {
  const { stopChild } = await import("../../src/adapters/process");
  const signals: string[] = [];
  let resolve!: (code: number) => void;
  const child = {
    exitCode: null as number | null,
    exited: new Promise<number>((done) => {
      resolve = done;
    }),
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      if (signal === "SIGKILL") {
        this.exitCode = 137;
        resolve(137);
      }
    },
  };
  await stopChild(child, 5);
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("image cleanup stops when the listing does not shrink", async () => {
  const { removeImages } = await import("../../src/core/build");
  const docker = new FakeDocker();
  docker.listImages = async () => ["hoist/hello:left"];
  docker.removeImage = async () => {};
  await expect(removeImages(docker, {})).rejects.toThrow(
    "images left: hoist/hello:left",
  );
});

test("image cleanup has a ten iteration limit", async () => {
  const { removeImages } = await import("../../src/core/build");
  const docker = new FakeDocker();
  let calls = 0;
  docker.listImages = async () =>
    Array.from({ length: 11 - calls++ }, (_, i) => `hoist/hello:left${i}`);
  docker.removeImage = async () => {};
  await expect(removeImages(docker, {})).rejects.toThrow(
    "exceeded 10 iterations; images left: hoist/hello:left0",
  );
});
