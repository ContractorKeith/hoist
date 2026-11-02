import { expect, spyOn, test } from "bun:test";
import { FakeCaddy } from "../../src/adapters/fakes/caddy";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { reserveRelease } from "../../src/core/build";
import { cutover } from "../../src/core/cutover";
import { prune } from "../../src/core/retention";

test("log removal failures preserve cutover, report once, and keep pruning other rows", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker(),
    caddy = new FakeCaddy();
  const app = store.createApp("hello", "hello.test", "/");
  store.setRetention(app.id, 1);
  const one = reserveRelease(store, app, "main", "a".repeat(40));
  one.status = "live";
  const two = reserveRelease(store, app, "main", "b".repeat(40));
  two.status = "built";
  await cutover(
    store,
    docker,
    caddy,
    app,
    two,
    null,
    async () => null,
    async () => {},
  );
  const later = reserveRelease(store, app, "main", "c".repeat(40));
  later.status = "stopped";
  const newest = reserveRelease(store, app, "main", "d".repeat(40));
  newest.status = "stopped";
  const lines: string[] = [];
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    await prune(
      store,
      docker,
      app,
      async (row) => {
        if (row.id === one.id)
          throw Object.assign(new Error("EACCES permission denied"), {
            path: "/logs/hello/main/v1",
          });
      },
      async (message) => {
        lines.push(message);
      },
    );
    expect(String(two.status)).toBe("live");
    expect(String(one.status)).toBe("stopped");
    expect(one.pruned_at).toBeUndefined();
    // Newest stopped row is kept by N=1; the older live row stays protected too.
    expect(later.pruned_at).toBeTruthy();
    expect(newest.pruned_at).toBeUndefined();
    expect(lines).toEqual([
      "prune: could not remove /logs/hello/main/v1: EACCES permission denied",
    ]);
    expect(stderr).toHaveBeenCalledWith(lines[0]);
    store.releases = () => {
      throw new Error("store unavailable");
    };
    await prune(
      store,
      docker,
      app,
      async () => {},
      () => {
        throw new Error("log unavailable");
      },
    );
    expect(String(two.status)).toBe("live");
  } finally {
    stderr.mockRestore();
  }
});

for (const missing of [false, true]) {
  test(`retention removes a shared pruned tag once without warnings (missing=${missing})`, async () => {
    const store = new FakeStore(),
      docker = new FakeDocker();
    const app = store.createApp("hello", "hello.test", "/");
    store.setRetention(app.id, 1);
    const one = reserveRelease(store, app, "main", "a".repeat(40));
    one.status = "stopped";
    const two = store.insertRelease({ ...one, number: 2 });
    const live = reserveRelease(store, app, "main", "c".repeat(40));
    live.status = "live";
    let calls = 0;
    docker.removeImage = async (image) => {
      calls++;
      if (missing || calls > 1)
        throw new Error(
          `Docker DELETE /images/${encodeURIComponent(image)}: 404 missing`,
        );
    };
    const warnings: string[] = [];
    await prune(
      store,
      docker,
      app,
      async () => {},
      async (line) => {
        warnings.push(line);
      },
    );
    expect(calls).toBe(1);
    expect(warnings).toEqual([]);
    expect(one.pruned_at).toBeTruthy();
    expect(two.pruned_at).toBeTruthy();
    expect(live.pruned_at).toBeUndefined();
  });
}

test("retention does not swallow a 404 mentioned inside a different Docker error", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker();
  const app = store.createApp("hello", "hello.test", "/");
  const row = reserveRelease(store, app, "main", "a".repeat(40));
  row.status = "failed";
  const message =
    "Docker DELETE /images/hoist%2Fhello%3Atag: 500 upstream: 404 missing";
  docker.removeImage = async () => {
    throw new Error(message);
  };
  const lines: string[] = [],
    stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    await prune(
      store,
      docker,
      app,
      async () => {},
      async (line) => {
        lines.push(line);
      },
    );
    expect(lines[0]).toContain(message);
  } finally {
    stderr.mockRestore();
  }
});
