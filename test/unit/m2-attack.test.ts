import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAppLocks } from "../../src/adapters/app-lock";
import { FakeAppLocks } from "../../src/adapters/fakes/app-lock";
import { FakeCaddy } from "../../src/adapters/fakes/caddy";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { reserveRelease } from "../../src/core/build";
import { reconcile } from "../../src/core/reconcile";
import { SqliteStore } from "../../src/store/sqlite";

async function database(
  run: (store: SqliteStore, root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "hoist-lease-")),
    store = new SqliteStore(root);
  try {
    await run(store, root);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("SQLite serializes 16 acquirers for 30 dead-owner reclamation rounds", async () => {
  await database(async (store, root) => {
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    const connections = Array.from({ length: 16 }, () => new SqliteStore(root));
    try {
      for (let round = 0; round < 30; round++) {
        store.db.run(
          "INSERT OR REPLACE INTO locks (name,owner_pid,heartbeat_at,acquired_at) VALUES ('app:hello',?,?,?)",
          [dead.pid, new Date().toISOString(), new Date().toISOString()],
        );
        const results = await Promise.allSettled(
          connections.map((connection) =>
            new SqliteAppLocks(connection).acquire("app:hello", {
              failFast: true,
            }),
          ),
        );
        const winners = results.filter(
          (result) => result.status === "fulfilled",
        );
        expect(winners).toHaveLength(1);
        expect(
          results.filter((result) => result.status === "rejected"),
        ).toHaveLength(15);
        for (const result of winners)
          if (result.status === "fulfilled") result.value.release();
        expect(store.lock("app:hello")).toBeNull();
      }
    } finally {
      for (const connection of connections) connection.close();
    }
  });
});

test("live fresh leases block acquisition, stale heartbeats expire and non-owner release is a no-op", async () => {
  await database(async (store) => {
    const now = new Date().toISOString();
    const other = Bun.spawn(["sleep", "30"]);
    try {
      store.db.run(
        "INSERT INTO locks (name,owner_pid,heartbeat_at,acquired_at) VALUES ('app:hello',?,?,?)",
        [other.pid, now, now],
      );
      const locks = new SqliteAppLocks(store);
      await expect(
        locks.acquire("app:hello", { failFast: true }),
      ).rejects.toThrow("another push to hello is in progress");
      store.releaseLock("app:hello", process.pid, now);
      expect(store.lock("app:hello")?.owner_pid).toBe(other.pid);
      store.db.run("UPDATE locks SET heartbeat_at=?", [
        new Date(Date.now() - 61000).toISOString(),
      ]);
      const lease = await locks.acquire("app:hello", { failFast: true });
      expect(store.lock("app:hello")?.owner_pid).toBe(process.pid);
      const row = store.lock("app:hello");
      if (!row) throw new Error("missing lease");
      expect(
        store.refreshLock(
          row.name,
          process.pid,
          row.acquired_at,
          new Date().toISOString(),
        ),
      ).toBe(true);
      lease.release();
      expect(store.lock("app:hello")).toBeNull();
    } finally {
      other.kill();
      await other.exited;
    }
  });
});

test("waiting for a lease honours abort and does not release another owner", async () => {
  await database(async (store) => {
    const locks = new SqliteAppLocks(store),
      held = await locks.acquire("app:hello");
    const controller = new AbortController();
    const waiting = locks.withLock(
      "hello",
      async () => {
        throw new Error("must not enter");
      },
      controller.signal,
    );
    controller.abort(new Error("shutdown"));
    await expect(waiting).rejects.toThrow("shutdown");
    expect(locks.isLocked("hello")).toBe(true);
    held.release();
  });
});

function setup() {
  const store = new FakeStore(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy(),
    locks = new FakeAppLocks();
  return { store, docker, caddy, locks };
}
async function live(h: ReturnType<typeof setup>, name: string, sha: string) {
  const app = h.store.createApp(name, `${name}.test`, "/"),
    row = reserveRelease(h.store, app, "main", sha.repeat(40));
  h.store.completeRelease(row.id);
  const id = await h.docker.createContainer({
    image: row.image,
    port: 8080,
    publishPort: "",
    labels: { "hoist.app": name, "hoist.release": String(row.id) },
  });
  await h.docker.startContainer(id);
  h.store.setReleaseState(row.id, "live", id);
  return { app, row, id };
}

test("a cutover between app reconciles survives without a final full config load", async () => {
  const h = setup();
  const alpha = await live(h, "alpha", "a");
  await live(h, "bravo", "b");
  const locks = {
    isLocked: () => false,
    withLock: async <T>(name: string, action: () => Promise<T>) => {
      if (name === "bravo")
        await h.caddy.upsertRoute(alpha.app.domain, "127.0.0.1:45000");
      return action();
    },
  };
  await reconcile(h.store, h.docker, h.caddy, locks, async () => {});
  expect(h.caddy.routes.get("alpha.test")).toBe("127.0.0.1:45000");
  expect(h.caddy.calls.some((call) => call.method === "loadConfig")).toBe(
    false,
  );
});

test("foreign container linkage is recovered without routing or removing the other app", async () => {
  const h = setup(),
    alpha = await live(h, "alpha", "a"),
    bravo = await live(h, "bravo", "b");
  h.store.setReleaseState(alpha.row.id, "live", bravo.id, "live");
  const logs: string[] = [];
  await reconcile(
    h.store,
    h.docker,
    h.caddy,
    h.locks,
    async () => {},
    undefined,
    (message) => logs.push(message),
  );
  expect(alpha.row.container_id).not.toBe(bravo.id);
  expect(h.docker.containers.has(bravo.id)).toBe(true);
  expect(h.caddy.routes.get("alpha.test")).not.toBe(
    h.caddy.routes.get("bravo.test"),
  );
  expect(logs.join("\n")).toContain("ownership does not match");
});

test("a built release candidate left by a dead hook is removed and failed", async () => {
  const h = setup(),
    app = h.store.createApp("hello", "hello.test", "/"),
    row = reserveRelease(h.store, app, "main", "a".repeat(40));
  h.store.completeRelease(row.id);
  const id = await h.docker.createContainer({
    image: row.image,
    port: 8080,
    publishPort: "",
    labels: { "hoist.app": "hello", "hoist.release": String(row.id) },
  });
  await h.docker.startContainer(id);
  const logs: string[] = [];
  await reconcile(
    h.store,
    h.docker,
    h.caddy,
    h.locks,
    async () => {},
    undefined,
    (message) => logs.push(message),
  );
  expect(row.status).toBe("failed");
  expect(h.docker.containers.has(id)).toBe(false);
  expect(logs.join("\n")).toContain("interrupted before cutover");
});

test("reclaim preserves the recorded Caddy until the new supervisor replaces it", async () => {
  await database(async (store) => {
    const first = "2026-11-01T00:00:00.000Z",
      second = "2026-11-01T00:02:00.000Z";
    store.acquireLock("serve", 111, first, () => false);
    store.setLockChild("serve", 111, first, 222);
    const claim = store.acquireLock("serve", 333, second, () => false);
    expect(claim.acquired).toBe(true);
    expect(store.lock("serve")?.child_pid).toBe(222);
    if (claim.acquired) expect(claim.previous?.child_pid).toBe(222);
    store.releaseLock("serve", 111, first);
    expect(store.lock("serve")?.owner_pid).toBe(333);
    store.setLockChild("serve", 333, second, 444);
    expect(store.lock("serve")?.child_pid).toBe(444);
    store.releaseLock("serve", 333, second);
  });
});

test("failed startup release retains an unreaped child for the next supervisor", async () => {
  await database(async (store) => {
    const lease = await new SqliteAppLocks(store).acquire("serve");
    lease.setChild(123);
    lease.release();
    expect(store.lock("serve")?.child_pid).toBe(123);
  });
});
