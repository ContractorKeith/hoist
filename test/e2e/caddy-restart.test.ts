import { expect, test } from "bun:test";
import { SqliteAppLocks } from "../../src/adapters/app-lock";
import { eventually } from "./harness";
import { withSSH } from "./ssh";

test.skipIf(process.env.HOIST_E2E !== "1")(
  "Caddy restart restores app routes within ten seconds and supervises exits during lease waits",
  async () => {
    await withSSH(async (h) => {
      await h.control("apps:create", h.appName);
      expect((await h.push()).code).toBe(0);
      const lease = await new SqliteAppLocks(h.store).acquire(
        `app:${h.appName}`,
      );
      try {
        for (let round = 0; round < 2; round++) {
          const pid = h.store.lock("serve")?.child_pid;
          if (!pid) throw new Error("Missing Caddy child PID");
          process.kill(pid, "SIGKILL");
          await eventually(async () => {
            const next = h.store.lock("serve")?.child_pid;
            expect(next).toBeTruthy();
            expect(next).not.toBe(pid);
            const response = await h.request();
            expect(response.status).toBe(200);
            await response.body?.cancel();
            const config = await fetch(
              `http://127.0.0.1:${h.admin}/config/apps/http/servers/hoist/routes`,
            );
            expect(config.ok).toBe(true);
            expect(await config.text()).toContain(`${h.appName}.example.test`);
            expect(h.getLogs()).toContain("hoist serve ready");
          }, 10000);
          // Let the post-restart repair enter its app-lease wait before killing again.
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
      } finally {
        lease.release();
      }
    });
  },
  120000,
);
