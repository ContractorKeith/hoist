import { expect, test } from "bun:test";
import { FakeCaddy } from "../../src/adapters/fakes/caddy";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import type { AppLocks } from "../../src/adapters/interfaces";
import { reconcile } from "../../src/core/reconcile";
import { retryReconcile } from "../../src/core/reconcile-retry";

test("restart reconcile retries at 5, 15 and 45 seconds until routes recover", async () => {
  const delays: number[] = [],
    logs: string[] = [];
  let calls = 0;
  await retryReconcile(
    async () => (++calls < 5 ? ["hello route: unavailable"] : []),
    new AbortController().signal,
    (line) => logs.push(line),
    async (ms) => {
      delays.push(ms);
    },
  );
  expect(delays).toEqual([5000, 15000, 45000, 45000]);
  expect(calls).toBe(5);
  expect(logs).toHaveLength(4);
  expect(logs[0]).toContain("hello route: unavailable; retrying in 5 s");
});

test("restart reconcile bounds lease waits and logs the timed-out app before retry", async () => {
  const store = new FakeStore();
  store.createApp("hello", "hello.test", "/");
  const shutdown = new AbortController(),
    logs: string[] = [];
  const locks: AppLocks = {
    isLocked: () => true,
    withLock: async (_app, _action, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      throw new Error("unreachable");
    },
  };
  await retryReconcile(
    (signal) =>
      reconcile(
        store,
        new FakeDocker(),
        new FakeCaddy(),
        locks,
        async () => {},
        undefined,
        (line) => logs.push(line),
        signal,
      ),
    shutdown.signal,
    (line) => logs.push(line),
    async () => {
      shutdown.abort();
    },
    1,
  );
  expect(logs[0]).toContain("hello: TimeoutError");
  expect(logs[1]).toContain("retrying in 5 s");
});

test("shutdown cancels restart retry delays without running another attempt", async () => {
  const shutdown = new AbortController();
  let calls = 0;
  await retryReconcile(
    async () => {
      calls++;
      return ["failed"];
    },
    shutdown.signal,
    () => {},
    async (_ms, signal) => {
      shutdown.abort();
      signal.throwIfAborted();
    },
  );
  expect(calls).toBe(1);
});
