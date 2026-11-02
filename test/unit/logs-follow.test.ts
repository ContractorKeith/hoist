import { expect, test } from "bun:test";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { reserveRelease } from "../../src/core/build";
import { liveLogs } from "../../src/core/logs";

function setup(branch = "main") {
  const store = new FakeStore(),
    docker = new FakeDocker();
  const app = store.createApp("hello", "hello.test", "/");
  const release = reserveRelease(store, app, branch, "a".repeat(40));
  store.completeRelease(release.id);
  store.setReleaseState(release.id, "live", "a".repeat(64));
  const controller = new AbortController();
  const chunks: Uint8Array[] = [];
  const options = { app: "hello", branch, follow: true, lines: 100 };
  const write = async (c: Uint8Array) => {
    chunks.push(c);
  };
  const run = () => liveLogs(store, docker, options, controller.signal, write);
  return {
    store,
    docker,
    app,
    release,
    controller,
    chunks,
    options,
    write,
    run,
  };
}

test("follow exits 1 if the live row disappears, even while Docker stays open", async () => {
  const h = setup();
  let cancelled = false;
  h.docker.containerLogs = async () =>
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
  const task = h.run();
  h.store.deleteApp(h.app.id);
  expect(await task).toBe(1);
  expect(Buffer.concat(h.chunks).toString()).toBe(
    "--- app hello has no live release ---\n",
  );
  expect(cancelled).toBe(true);
});

test("follow exits 1 after two unchanged polls following EOF", async () => {
  const h = setup();
  expect(await h.run()).toBe(1);
  expect(Buffer.concat(h.chunks).toString()).toBe(
    "hello\n--- container exited ---\n",
  );
}, 6000);

for (const open of [false, true]) {
  test(`same release reattaches with the old stream ${open ? "open" : "closed"}`, async () => {
    const h = setup();
    const ids: string[] = [];
    h.docker.containerLogs = async (id) => {
      ids.push(id);
      if (open && ids.length === 1)
        return new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("old\n"));
          },
        });
      return new Blob([ids.length === 1 ? "old\n" : "recovered\n"]).stream();
    };
    const task = liveLogs(
      h.store,
      h.docker,
      h.options,
      h.controller.signal,
      async (c) => {
        await h.write(c);
        if (new TextDecoder().decode(c) === "old\n")
          h.store.setReleaseState(h.release.id, "live", "b".repeat(64), "live");
        else h.controller.abort();
      },
    );
    expect(await task).toBe(0);
    expect(ids).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(Buffer.concat(h.chunks).toString()).toBe("old\nrecovered\n");
  });
}

test("branch slug selects feature/x when feature-x is requested", async () => {
  const h = setup("feature/x");
  expect(
    await liveLogs(
      h.store,
      h.docker,
      { ...h.options, branch: "feature-x", follow: false },
      h.controller.signal,
      h.write,
    ),
  ).toBe(0);
  expect(Buffer.concat(h.chunks).toString()).toBe("hello\n");
});

for (const cause of ["caller", "takeover"] as const) {
  test(`a real Docker error racing ${cause} cancellation is rethrown`, async () => {
    const h = setup();
    const failure = new Error("real stream failure");
    h.docker.containerLogs = async (_id, _follow, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(failure), {
          once: true,
        });
        if (cause === "caller") h.controller.abort();
        else {
          const next = reserveRelease(h.store, h.app, "main", "b".repeat(40));
          h.store.completeRelease(next.id);
          h.store.setReleaseState(h.release.id, "stopped");
          h.store.setReleaseState(next.id, "live", "b".repeat(64));
        }
      });
    await expect(h.run()).rejects.toBe(failure);
  });
}

test("an aborted Docker request exits 0 when the caller cancels", async () => {
  const h = setup();
  h.docker.containerLogs = async (_id, _follow, signal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(new Error("request failed", { cause: signal.reason })),
        { once: true },
      );
      h.controller.abort();
    });
  expect(await h.run()).toBe(0);
});

test("a real reader error is not hidden by a racing caller abort", async () => {
  const h = setup();
  const failure = new Error("reader failed");
  h.docker.containerLogs = async () =>
    new ReadableStream({
      pull(c) {
        c.error(failure);
        h.controller.abort();
      },
    });
  await expect(h.run()).rejects.toBe(failure);
});
