import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { savedLogs } from "../../src/cli/logs";
import { releaseLogPath } from "../../src/core/logs";
import { SqliteStore } from "../../src/store/sqlite";

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  test(`saved logs cancel a sink that never drains on ${signal}`, async () => {
    const controller = new AbortController();
    let closed = false,
      writes = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([0, 255, 10]));
      },
      cancel() {
        closed = true;
      },
    });
    const result = await savedLogs(stream, controller.signal, () => {
      writes++;
      queueMicrotask(() => controller.abort(code));
      return new Promise(() => {});
    });
    expect(result).toBe(code);
    expect(writes).toBe(1);
    expect(closed).toBe(true);
  });

  test(`saved log CLI exits ${code} on ${signal} with a blocked output pipe`, async () => {
    const root = await mkdtemp(join(tmpdir(), "hoist-saved-log-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const store = new SqliteStore(root);
      try {
        store.createApp("hello", "hello.test", "/");
      } finally {
        store.close();
      }
      const path = releaseLogPath(root, "hello", "main", "v1");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.alloc(4 * 1024 * 1024, 65));
      const proc = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../../src/cli/index.ts"),
          "logs",
          "hello",
          "--release",
          "v1",
        ],
        {
          env: { ...process.env, HOIST_DIR: root },
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      child = proc;
      const reader = proc.stdout.getReader();
      expect((await reader.read()).done).toBe(false);
      reader.releaseLock();
      await Bun.sleep(100);
      proc.kill(signal);
      expect(
        await Promise.race([
          proc.exited,
          Bun.sleep(1500).then(() => {
            throw new Error(
              "saved logs ignored signal while output was blocked",
            );
          }),
        ]),
      ).toBe(code);
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      await child?.exited;
      await rm(root, { recursive: true, force: true });
    }
  });
}
