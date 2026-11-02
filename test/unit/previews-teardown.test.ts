import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAppLocks } from "../../src/adapters/fakes/app-lock";
import { FakeCaddy } from "../../src/adapters/fakes/caddy";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { reserveRelease } from "../../src/core/build";
import {
  destroyPreview,
  setMainBranch,
  sweepPreviews,
} from "../../src/core/previews";
import { reconcile } from "../../src/core/reconcile";

test("teardown retries safely and a deleted branch cannot remove a reused slug", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-retry-"));
  const store = new FakeStore(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy();
  const app = store.createApp("hello", "hello.test", "/");
  try {
    reserveRelease(store, app, "Feature/X", "a".repeat(40));
    caddy.routes.set("feature-x.hello.test", "127.0.0.1:30000");
    const remove = caddy.removeRoute.bind(caddy);
    caddy.removeRoute = async () => {
      throw new Error("Caddy unavailable");
    };
    await expect(
      destroyPreview(root, store, docker, caddy, app, "Feature/X"),
    ).rejects.toThrow("unavailable");
    expect(store.previews(app.id)).toHaveLength(1);
    caddy.removeRoute = remove;
    await destroyPreview(root, store, docker, caddy, app, "Feature/X");
    reserveRelease(store, app, "feature-x", "b".repeat(40));
    caddy.routes.set("feature-x.hello.test", "127.0.0.1:30001");
    await expect(
      destroyPreview(root, store, docker, caddy, app, "Feature/X"),
    ).rejects.toThrow("no preview Feature/X for hello");
    expect(store.previews(app.id)[0]?.branch).toBe("feature-x");
    expect(caddy.routes.get("feature-x.hello.test")).toBe("127.0.0.1:30001");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sweeper continues after one preview cleanup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-error-"));
  const store = new FakeStore(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy();
  const app = store.createApp("hello", "hello.test", "/");
  const now = Date.now();
  try {
    for (const branch of ["broken", "old"]) {
      reserveRelease(store, app, branch, "a".repeat(40));
      store.upsertPreview({
        app_id: app.id,
        branch,
        slug: branch,
        last_push_at: new Date(now - 8 * 86400000).toISOString(),
      });
    }
    caddy.removeRoute = async (host) => {
      if (host.startsWith("broken.")) throw new Error("cleanup failed");
    };
    const messages: string[] = [];
    await sweepPreviews(
      root,
      store,
      docker,
      caddy,
      new FakeAppLocks(),
      now,
      7,
      (msg) => messages.push(msg),
    );
    expect(store.previews(app.id).map((p) => p.branch)).toEqual(["broken"]);
    expect(messages[0]).toContain("broken: Error: cleanup failed");
    expect(messages[1]).toBe("Swept preview hello old");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconcile rereads main branch after waiting for the app lease", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy();
  const app = store.createApp("hello", "hello.test", "/");
  const release = reserveRelease(store, app, "main", "a".repeat(40));
  store.completeRelease(release.id);
  store.setReleaseState(release.id, "live");
  const locks = new FakeAppLocks();
  const acquire = locks.withLock.bind(locks);
  locks.withLock = (name, action, signal) =>
    acquire(
      name,
      async () => {
        setMainBranch(store, app, "master");
        return action();
      },
      signal,
    );
  await reconcile(store, docker, caddy, locks, async () => {});
  expect(caddy.routes.has("main.hello.test")).toBe(true);
  expect(caddy.routes.has("hello.test")).toBe(false);
});
