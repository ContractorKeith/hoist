import { expect, test } from "bun:test";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { reserveRelease } from "../../src/core/build";
import { logStream } from "../../src/web/sse";

function setup() {
  const store = new FakeStore(),
    docker = new FakeDocker();
  const app = store.createApp("hello", "hello.test", "/");
  const release = reserveRelease(store, app, "main", "a".repeat(40));
  store.completeRelease(release.id);
  store.setReleaseState(release.id, "live", "c".repeat(64));
  return { store, docker, app, release };
}
test("SSE frames split chunks into lines and closes Docker on reader cancellation", async () => {
  const { store, docker } = setup();
  let cancelled = false,
    signal: AbortSignal | undefined;
  docker.containerLogs = async (_id, _follow, passed) => {
    signal = passed;
    return new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("<script>\r\npar"));
        c.enqueue(new TextEncoder().encode("tial\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
  };
  const response = logStream(
    store,
    docker,
    "hello",
    "main",
    new Request("https://hoist.test"),
    () => true,
  );
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(
    "event: message\ndata: <script>\n\n",
  );
  expect(new TextDecoder().decode((await reader?.read())?.value)).toContain(
    "data: partial\n\n",
  );
  await reader?.cancel();
  await Bun.sleep(20);
  expect(cancelled).toBe(true);
  expect(signal?.aborted).toBe(true);
});
test("SSE emits takeover reason and a final event, then releases Docker", async () => {
  const { store, docker, app, release } = setup();
  const response = logStream(
    store,
    docker,
    "hello",
    "main",
    new Request("https://hoist.test"),
    () => true,
  );
  const body = response.text();
  const next = reserveRelease(store, app, "main", "b".repeat(40));
  store.completeRelease(next.id);
  store.setReleaseState(release.id, "stopped");
  store.setReleaseState(next.id, "live", "d".repeat(64));
  const text = await body;
  expect(text).toContain("data: --- release v2 took over ---");
  expect(text).toContain("event: end");
});
test("SSE request abort cancels an idle Docker stream", async () => {
  const { store, docker } = setup();
  let cancelled = false;
  docker.containerLogs = async () =>
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
  const controller = new AbortController();
  const response = logStream(
    store,
    docker,
    "hello",
    "main",
    new Request("https://hoist.test", { signal: controller.signal }),
    () => true,
  );
  const consume = response.text().catch(() => "");
  await Bun.sleep(10);
  controller.abort();
  await consume;
  expect(cancelled).toBe(true);
});

test("an oversized line remains one bounded SSE event across Docker chunks", async () => {
  const { store, docker } = setup();
  docker.containerLogs = async () =>
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("x".repeat(70000)));
        c.enqueue(new TextEncoder().encode(`${"y".repeat(70000)}\nnext\n`));
      },
    });
  const response = logStream(
    store,
    docker,
    "hello",
    "main",
    new Request("https://hoist.test"),
    () => true,
  );
  const reader = response.body?.getReader();
  const first = new TextDecoder().decode((await reader?.read())?.value);
  expect(first).toBe(
    `event: message\ndata: ${"x".repeat(65536)} … [line truncated]\n\n`,
  );
  expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(
    "event: message\ndata: next\n\n",
  );
  await reader?.cancel();
});
