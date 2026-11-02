import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAppLocks } from "../../src/adapters/fakes/app-lock";
import { FakeCaddy } from "../../src/adapters/fakes/caddy";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { reserveRelease } from "../../src/core/build";
import { cutover } from "../../src/core/cutover";
import {
  destroyPreview,
  previewHost,
  previewTTL,
  releaseHost,
  setMainBranch,
  sweepPreviews,
} from "../../src/core/previews";
import { reconcile } from "../../src/core/reconcile";
import { privatePath } from "../../src/data";
import { SqliteStore } from "../../src/store/sqlite";

test("preview hosts use slugs and refuse DNS length violations", () => {
  const app = {
    id: 1,
    name: "hello",
    domain: "hello.example.test",
    health_path: "/",
  };
  expect(previewHost(app, "Feature/X-Y")).toBe(
    "feature-x-y.hello.example.test",
  );
  expect(releaseHost({ ...app, main_branch: "master" }, "master")).toBe(
    app.domain,
  );
  expect(releaseHost({ ...app, main_branch: "master" }, "main")).toBe(
    "main.hello.example.test",
  );
  expect(() => previewHost(app, "x".repeat(64))).toThrow();
  expect(() =>
    previewHost({ ...app, domain: `${"a".repeat(64)}.test` }, "x"),
  ).toThrow("63");
  const domain = [63, 63, 63, 58].map((n) => "a".repeat(n)).join(".");
  expect(domain.length).toBe(250);
  expect(previewHost({ ...app, domain }, "xx").length).toBe(253);
  expect(() => previewHost({ ...app, domain }, "xxx")).toThrow("253");
});

test("reserve timestamps previews and names the existing colliding branch", () => {
  const store = new FakeStore();
  const app = store.createApp("hello", "hello.test", "/");
  reserveRelease(store, app, "Feature/X-Y", "a".repeat(40));
  expect(store.previews(app.id)[0]).toMatchObject({
    branch: "Feature/X-Y",
    slug: "feature-x-y",
  });
  expect(
    Date.parse(store.previews(app.id)[0]?.last_push_at ?? ""),
  ).toBeGreaterThan(Date.now() - 1000);
  expect(() =>
    reserveRelease(store, app, "feature-x-y", "b".repeat(40)),
  ).toThrow("Feature/X-Y");
  expect(() =>
    reserveRelease(
      store,
      { ...app, domain: "bad domain" },
      "other",
      "a".repeat(40),
    ),
  ).toThrow();
  expect(store.previews(app.id)).toHaveLength(1);
});

test("SQLite migrates main branch and preview state persists with transactional delete", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-store-"));
  const store = new SqliteStore(root);
  try {
    const app = store.createApp("hello", "hello.test", "/");
    setMainBranch(store, app, "master");
    expect(store.app("hello")?.main_branch).toBe("master");
    reserveRelease(store, store.app("hello") ?? app, "feature", "a".repeat(40));
    expect(store.previews(app.id)).toHaveLength(1);
    store.deletePreview(app.id, "feature");
    expect(store.releases(app.id)).toEqual([]);
    expect(store.previews(app.id)).toEqual([]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("sweep rechecks under lease, removes all preview resources, leaves fresh and main live", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-sweep-"));
  const store = new FakeStore(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy();
  const app = store.createApp("hello", "hello.test", "/");
  const now = Date.parse("2026-11-10T00:00:00Z");
  try {
    for (const branch of ["main", "old", "fresh", "refreshed"]) {
      const release = reserveRelease(store, app, branch, "a".repeat(40));
      docker.images.set(release.image, {
        "hoist.app": app.name,
        "hoist.release": String(release.id),
      });
      store.completeRelease(release.id);
      await cutover(
        store,
        docker,
        caddy,
        app,
        release,
        null,
        async () => null,
        async () => {},
        async () => {},
        releaseHost(app, branch),
      );
      if (branch !== "main")
        store.upsertPreview({
          app_id: app.id,
          branch,
          slug: branch,
          last_push_at: new Date(
            now - (branch === "fresh" ? 1 : 8) * 86400000,
          ).toISOString(),
        });
    }
    const path = privatePath(
      join(root, "releases/hello/old/v1/build.log"),
      false,
      false,
      root,
    );
    await writeFile(path, "old logs");
    const locks = new FakeAppLocks();
    const acquire = locks.withLock.bind(locks);
    locks.withLock = (name, action, signal) =>
      acquire(
        name,
        async () => {
          store.upsertPreview({
            app_id: app.id,
            branch: "refreshed",
            slug: "refreshed",
            last_push_at: new Date(now).toISOString(),
          });
          return action();
        },
        signal,
      );
    const messages: string[] = [];
    await sweepPreviews(root, store, docker, caddy, locks, now, 7, (msg) =>
      messages.push(msg),
    );
    expect(messages).toEqual(["Swept preview hello old"]);
    expect(store.previews(app.id).map((p) => p.branch)).toEqual([
      "fresh",
      "refreshed",
    ]);
    expect(store.releases(app.id).map((r) => r.branch)).toEqual([
      "main",
      "fresh",
      "refreshed",
    ]);
    expect(await docker.listImages({ "hoist.app": app.name })).toHaveLength(3);
    expect(await docker.listContainers({ "hoist.app": app.name })).toHaveLength(
      3,
    );
    expect(caddy.routes.has("old.hello.test")).toBe(false);
    expect(await stat(path).catch(() => null)).toBeNull();
    await expect(
      destroyPreview(root, store, docker, caddy, app, "main"),
    ).rejects.toThrow("main branch");
    // Missing preview containers are recovered at their own host.
    const fresh = store.releases(app.id).find((r) => r.branch === "fresh");
    if (!fresh?.container_id) throw new Error("missing fresh");
    await docker.removeContainer(fresh.container_id);
    await reconcile(store, docker, caddy, locks, async () => {});
    expect([...caddy.routes.keys()].sort()).toEqual([
      "fresh.hello.test",
      "hello.test",
      "refreshed.hello.test",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TTL override is bounded", () => {
  expect(previewTTL("1")).toBe(1);
  for (const value of ["0", "366", "1.5", "NaN"])
    expect(() => previewTTL(value)).toThrow("1 to 365");
});
