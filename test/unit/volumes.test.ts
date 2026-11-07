import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAppLocks } from "../../src/adapters/app-lock";
import { FakeCaddy } from "../../src/adapters/fakes/caddy";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { appsSet, parseCli } from "../../src/cli/apps";
import { checkVolumes } from "../../src/cli/doctor-volumes";
import { volumeRemoveCommand } from "../../src/cli/volumes";
import { cutover } from "../../src/core/cutover";
import { reclassification } from "../../src/core/previews";
import {
  productionVolume,
  setVolume,
  volumePath,
} from "../../src/core/volumes";
import { migrations } from "../../src/store/migrations";
import { SqliteStore } from "../../src/store/sqlite";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}

test("volume paths reject unsafe and non-normalized targets", () => {
  for (const path of [
    "",
    "data",
    "/",
    "/data/",
    "/a//b",
    "/a/./b",
    "/a/../b",
    "/proc",
    "/sys/x",
    "/dev/x",
    "/a\0b",
    "/a\nb",
    `/${"a".repeat(255)}`,
  ])
    expect(() => volumePath(path)).toThrow();
  for (const path of [
    "/data",
    "/var/lib/app",
    "/device",
    `/${"a".repeat(254)}`,
  ])
    expect(volumePath(path)).toBe(path);
  expect(parseCli(["apps:create", "app", "--volume", "/data"]).volume).toBe(
    "/data",
  );
});

test("migration preserves existing apps and stores a nullable volume path", async () => {
  const root = await mkdtemp(join(tmpdir(), "volume-store-"));
  const old = new Database(join(root, "hoist.db"));
  for (const sql of migrations.slice(0, 7)) old.exec(sql);
  old.exec(`PRAGMA user_version = 7`);
  old.run(
    "INSERT INTO apps(name, domain) VALUES ('existing', 'existing.test')",
  );
  old.close();
  const store = new SqliteStore(root);
  try {
    expect(store.app("existing")?.volume_path).toBeNull();
    expect(store.app("existing")?.domain).toBe("existing.test");
    const app = store.createApp("app", "app.test", "/");
    expect(app.volume_path).toBeNull();
    setVolume(store, app, "/data");
    expect(store.app("app")?.volume_path).toBe("/data");
    expect(() =>
      setVolume(store, required(store.app("app")), "/other"),
    ).toThrow("destroy the volume first");
    store.setVolumePath(app.id, null);
    setVolume(store, required(store.app("app")), "/other");
    expect(store.app("app")?.volume_path).toBe("/other");
  } finally {
    store.close();
    await rm(root, { recursive: true });
  }
});

test("production volume is reused, previews excluded, foreign ownership refused", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker();
  const app = store.createApp("app", "app.test", "/");
  await appsSet(store, ["apps:set", "app", "volume=/data"]);
  expect(await productionVolume(docker, app, "preview")).toBeUndefined();
  expect(docker.volumes.size).toBe(0);
  expect(await productionVolume(docker, app, "main")).toEqual({
    name: "hoist-app-data",
    path: "/data",
  });
  await productionVolume(docker, app, "main");
  expect(docker.calls.filter((c) => c.method === "createVolume")).toHaveLength(
    1,
  );
  expect(await checkVolumes(store, docker)).toContain(
    "hoist-app-data at /data",
  );
  docker.volumes.set("hoist-app-data", { "hoist.app-id": "999" });
  await expect(productionVolume(docker, app, "main")).rejects.toThrow(
    "ownership",
  );
});

test("doctor loudly reports missing volumes and orphans", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker();
  const app = store.createApp("app", "app.test", "/");
  setVolume(store, app, "/data");
  await expect(checkVolumes(store, docker)).rejects.toThrow(
    "recreate it EMPTY",
  );
  docker.volumes.set("hoist-unknown-data", {
    "hoist.app": "unknown",
    "hoist.app-id": "999",
  });
  await expect(checkVolumes(store, docker)).rejects.toThrow(
    "Orphan volume hoist-unknown-data",
  );
});

test("volume removal refuses a held app lease before touching Docker", async () => {
  const store = new FakeStore();
  const app = store.createApp("busy", "busy.test", "/");
  setVolume(store, app, "/data");
  const lease = await new SqliteAppLocks(store).acquire("app:busy");
  try {
    await expect(
      volumeRemoveCommand("/unused", store, [
        "apps:volume:rm",
        "busy",
        "--force",
      ]),
    ).rejects.toThrow("another push");
    expect(store.app("busy")?.volume_path).toBe("/data");
  } finally {
    lease.release();
  }
});

test("adding a volume leaves live containers alone until the next cutover", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy();
  const app = store.createApp("app", "app.test", "/");
  app.main_branch = "production";
  const first = store.insertRelease({
    app_id: app.id,
    branch: "production",
    number: 1,
    git_sha: "a".repeat(40),
    image: "hoist/app:first",
    config_json: "{}",
    status: "built",
  });
  await cutover(
    store,
    docker,
    caddy,
    app,
    first,
    null,
    async () => null,
    async () => {},
  );
  const original = first.container_id;
  setVolume(store, app, "/data");
  expect(docker.volumes.size).toBe(0);
  const second = store.insertRelease({
    ...first,
    number: 2,
    image: "hoist/app:second",
    status: "built",
  });
  await cutover(
    store,
    docker,
    caddy,
    app,
    second,
    null,
    async () => null,
    async () => {
      expect(docker.running.has(required(original))).toBe(true);
      expect(docker.running.size).toBe(2);
    },
  );
  const specs = docker.calls
    .filter((c) => c.method === "createContainer")
    .map((c) => c.args[0]);
  expect(specs[0]).toMatchObject({ volume: undefined });
  expect(specs[1]).toHaveProperty("volume.name", "hoist-app-data");
  expect(docker.volumes.size).toBe(1);
  expect(reclassification(store, app, "other")).toEqual([]);
  expect(reclassification(store, app, "production")).toEqual([]);
  expect(first.config_json).toBe("{}");
  expect(first.image).toBe("hoist/app:first");
});
