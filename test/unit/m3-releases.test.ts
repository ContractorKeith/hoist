import { expect, test } from "bun:test";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { appsSet } from "../../src/cli/apps";
import { reserveRelease } from "../../src/core/build";
import { prune, retentionSelection } from "../../src/core/retention";
import { copyRelease, rollbackTarget } from "../../src/core/rollback";

function fixture() {
  const store = new FakeStore();
  const app = store.createApp("hello", "hello.example.test", "/");
  const release = () => reserveRelease(store, app, "main", "a".repeat(40));
  return { store, app, release };
}

test("rollback selection, refusals, snapshot copying, restart and numbering", async () => {
  const { store, app, release } = fixture();
  expect(() => copyRelease(store, app, true)).toThrow("no live");
  const one = release();
  one.status = "stopped";
  one.config_json = '{"A":"old ciphertext"}';
  const two = release();
  two.status = "live";
  const failed = release();
  failed.status = "failed";
  const building = release();
  expect(rollbackTarget(store.rows).id).toBe(one.id);
  for (const target of [
    "",
    "v99",
    "v0",
    "nope",
    `v${failed.number}`,
    `v${building.number}`,
  ])
    expect(() => rollbackTarget(store.rows, target)).toThrow();
  const copy = copyRelease(store, app, false, "v1");
  expect(copy.number).toBe(5);
  expect(copy.image).toBe(one.image);
  expect(copy.config_json).toBe(one.config_json);
  two.status = "stopped";
  copy.status = "live";
  expect(rollbackTarget(store.rows).id).toBe(two.id);
  store.setConfig(app.id, "A", "new ciphertext");
  const restarted = copyRelease(store, app, true);
  expect(restarted.image).toBe(copy.image);
  expect(restarted.config_json).toBe('{"A":"new ciphertext"}');
  one.pruned_at = "now";
  expect(() => rollbackTarget(store.rows, "v1")).toThrow("pruned");
});

test("retention per branch, live protection, failed logs, shared tags and numbering", async () => {
  const { store, app, release } = fixture();
  const docker = new FakeDocker();
  for (let i = 0; i < 6; i++) {
    const row = release();
    row.status = "stopped";
    docker.images.set(row.image, {});
  }
  const live = store.rows[5];
  if (!live) throw new Error("missing release");
  live.status = "live";
  expect(retentionSelection(store.rows, 5).map((r) => r.number)).toEqual([1]);
  const failed = release();
  failed.status = "failed";
  docker.images.set(failed.image, {});
  const preview = reserveRelease(store, app, "feature", "b".repeat(40));
  preview.status = "built";
  const removed: number[] = [];
  await prune(store, docker, app, async (row) => {
    removed.push(row.number);
  });
  expect(removed).toEqual([1]);
  expect(docker.images.size).toBe(5);
  expect(failed.pruned_at).toBeUndefined();
  const copy = copyRelease(store, app, false, "v2");
  copy.status = "live";
  live.status = "stopped";
  appsSet(store, ["apps:set", "hello", "retention=1"]);
  await prune(store, docker, app, async () => {});
  expect([...docker.images.keys()]).toEqual([copy.image]);
  expect(preview.pruned_at).toBeUndefined();
  expect(copy.pruned_at).toBeUndefined();
  expect(release().number).toBe(9);
  for (const setting of [
    "retention=0",
    "retention=101",
    "retention=1x",
    "branch=foo",
  ])
    expect(() => appsSet(store, ["apps:set", "hello", setting])).toThrow();
});
