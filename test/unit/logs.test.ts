import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { reserveRelease } from "../../src/core/build";
import {
  checkLogPath,
  liveLogs,
  releaseLogPath,
  removeReleaseLogs,
} from "../../src/core/logs";

function setup(branch = "main") {
  const store = new FakeStore(),
    docker = new FakeDocker();
  const app = store.createApp("hello", "hello.test", "/");
  const release = reserveRelease(store, app, branch, "a".repeat(40));
  store.completeRelease(release.id);
  store.setReleaseState(release.id, "live", "a".repeat(64));
  return { store, docker, app, release };
}
const options = { app: "hello", branch: "main", follow: false, lines: 100 };

test("runtime logs preserve escape sequences and non-UTF-8 bytes, removing only CR", async () => {
  const { store, docker } = setup();
  const original = docker.containerLogs.bind(docker);
  docker.containerLogs = async (...args) => {
    await original(...args);
    return new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([27, 91, 51, 49, 109, 255, 13]));
        c.enqueue(new Uint8Array([10, 13, 65, 10]));
        c.close();
      },
    });
  };
  const chunks: Uint8Array[] = [];
  await liveLogs(
    store,
    docker,
    { ...options, lines: 1 },
    new AbortController().signal,
    async (c) => {
      chunks.push(c);
    },
  );
  expect([...Buffer.concat(chunks)]).toEqual([
    27, 91, 51, 49, 109, 255, 10, 65, 10,
  ]);
  expect(docker.calls[0]?.args.slice(0, 2)).toEqual(["a".repeat(64), false]);
  expect(docker.calls[0]?.args[3]).toBe(1);
});

test("follow survives old stream EOF and reports only the selected branch takeover", async () => {
  const { store, docker, app, release } = setup();
  const chunks: Uint8Array[] = [];
  const following = liveLogs(
    store,
    docker,
    { ...options, follow: true },
    new AbortController().signal,
    async (c) => {
      chunks.push(c);
    },
  );
  const other = reserveRelease(store, app, "feature", "b".repeat(40));
  store.completeRelease(other.id);
  store.setReleaseState(other.id, "live", "b".repeat(64));
  const next = reserveRelease(store, app, "main", "c".repeat(40));
  store.completeRelease(next.id);
  store.setReleaseState(release.id, "stopped");
  store.setReleaseState(next.id, "live", "c".repeat(64));
  await following;
  expect(Buffer.concat(chunks).toString()).toBe(
    "hello\n--- release v2 took over ---\n",
  );
  expect(docker.calls[0]?.args[1]).toBe(true);
  expect((docker.calls[0]?.args[2] as AbortSignal | undefined)?.aborted).toBe(
    true,
  );
});

test("caller abort cancels an open follow stream and exits cleanly", async () => {
  const { store, docker } = setup("feature/x");
  const controller = new AbortController();
  let cancelled = false;
  docker.containerLogs = async () =>
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([65]));
      },
      cancel() {
        cancelled = true;
      },
    });
  await liveLogs(
    store,
    docker,
    { ...options, branch: "feature/x", follow: true },
    controller.signal,
    async () => {
      controller.abort();
    },
  );
  expect(cancelled).toBe(true);
});

test("unknown app, absent live release, and Docker errors fail", async () => {
  const { store, docker, release } = setup();
  await expect(
    liveLogs(
      store,
      docker,
      { ...options, app: "nosuch" },
      new AbortController().signal,
      async () => {},
    ),
  ).rejects.toThrow("Unknown app");
  docker.containerLogs = async () => {
    throw new Error("Docker failed");
  };
  await expect(
    liveLogs(
      store,
      docker,
      options,
      new AbortController().signal,
      async () => {},
    ),
  ).rejects.toThrow("Docker failed");
  store.setReleaseState(release.id, "stopped");
  await expect(
    liveLogs(
      store,
      docker,
      options,
      new AbortController().signal,
      async () => {},
    ),
  ).rejects.toThrow("No live release");
});

test("prune hook removes stopped logs, protects live logs, and refuses symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoist-logs-"));
  try {
    const { store, release } = setup();
    const path = releaseLogPath(root, "hello", "main", "v1");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "build\n");
    await expect(
      removeReleaseLogs(root, "hello", "main", 1, store),
    ).rejects.toThrow("live release");
    expect((await stat(path)).isFile()).toBe(true);
    store.setReleaseState(release.id, "stopped");
    await removeReleaseLogs(root, "hello", "main", 1, store);
    expect(await stat(dirname(path)).catch(() => null)).toBeNull();
    await symlink(root, dirname(path));
    await expect(checkLogPath(root, path)).rejects.toThrow("symlink");
    await expect(
      removeReleaseLogs(root, "hello", "main", 1, store),
    ).rejects.toThrow("symlink");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
