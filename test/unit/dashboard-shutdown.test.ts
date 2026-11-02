import { expect, test } from "bun:test";
import { SqliteAppLocks } from "../../src/adapters/app-lock";
import { releasesCommand } from "../../src/cli/releases";
import { Actions } from "../../src/web/actions";
import { setup } from "./dashboard-support";

test("shutdown reaches a never-resolving action and finish is bounded", async () => {
  const shutdown = new AbortController();
  let passed: AbortSignal | undefined;
  const actions = new Actions(async (_args, signal) => {
    passed = signal;
    await new Promise(() => {});
  }, shutdown.signal);
  actions.start("hello", "owner", "restart", "");
  shutdown.abort();
  expect(passed?.aborted).toBe(true);
  expect(actions.status("hello", "owner")?.message).toBe(
    "Interrupted by shutdown",
  );
  await Promise.race([
    actions.finish(20),
    Bun.sleep(200).then(() => {
      throw new Error("finish did not respect its bound");
    }),
  ]);
  expect(actions.status("hello", "owner")?.running).toBe(false);
});
test("the CLI release path aborts while waiting on the app lease", async () => {
  const h = await setup();
  h.store.createApp("hello", "hello.test", "/");
  const lease = await new SqliteAppLocks(h.store).acquire("app:hello");
  const shutdown = new AbortController();
  try {
    const running = releasesCommand(
      h.root,
      h.store,
      ["restart", "hello"],
      shutdown.signal,
    );
    shutdown.abort(new Error("shutdown test"));
    await expect(running).rejects.toThrow("shutdown test");
    expect(h.store.releases(h.store.app("hello")?.id ?? 0)).toEqual([]);
  } finally {
    lease.release();
    await h.close();
  }
});
