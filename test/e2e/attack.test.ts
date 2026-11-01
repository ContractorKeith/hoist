import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SqliteAppLocks } from "../../src/adapters/app-lock";
import { Caddy } from "../../src/adapters/caddy";
import { checkHealth } from "../../src/adapters/health";
import { reserveRelease } from "../../src/core/build";
import { cutover } from "../../src/core/cutover";
import { eventually } from "./harness";
import { command, ok, withSSH } from "./ssh";

const scenario = process.env.HOIST_E2E !== undefined ? test : test.skip;
const cli = join(import.meta.dir, "../../src/cli/index.ts");
async function adminReady(port: number) {
  await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/config/`, {
      signal: AbortSignal.timeout(500),
    });
    expect(response.ok).toBe(true);
    await response.body?.cancel();
  });
}

scenario(
  "one supervisor per HOIST_DIR and SIGKILL restart reaps the recorded Caddy",
  async () => {
    await withSSH(async (h) => {
      await h.control("apps:create", "hello");
      expect((await h.push()).code).toBe(0);
      await eventually(async () => {
        expect(await (await h.request()).text()).toBe("hello from hoist\n");
      });
      const duplicate = await command([process.execPath, cli, "serve"], {
        env: h.env,
      });
      expect(duplicate.code).not.toBe(0);
      expect(duplicate.output).toContain(
        `hoist serve is already running (pid ${h.getServer()?.pid})`,
      );
      const old = h.store.lock("serve")?.child_pid;
      if (!old) throw new Error("missing recorded Caddy");
      await h.killServe();
      expect(await readFile(`/proc/${old}/cmdline`, "utf8")).toContain("caddy");
      const server = await h.startServe();
      const children = (
        await readFile(
          `/proc/${server.pid}/task/${server.pid}/children`,
          "utf8",
        )
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      expect(children).toHaveLength(1);
      expect(Number(children[0])).not.toBe(old);
      expect(h.store.lock("serve")?.child_pid).toBe(Number(children[0]));
      expect(
        (
          await readFile(`/proc/${old}/cmdline`, "utf8").catch(() => "")
        ).includes("caddy"),
      ).toBe(false);
      for (let i = 0; i < 20; i++) {
        const response = await h.request();
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("hello from hoist\n");
      }
      await h.control("apps:destroy", "hello", "--force");
    });
  },
  90000,
);

scenario(
  "reconcile waiting on bravo cannot overwrite a fresh hello cutover",
  async () => {
    await withSSH(async (h) => {
      await h.control("apps:create", "hello");
      expect((await h.push()).code).toBe(0);
      await h.control("apps:create", "zbravo");
      await h.stopServe();
      // Observe hello's lease release before starting its push; bravo remains held.
      h.store.db.exec(
        "CREATE TABLE reconcile_probe (name TEXT); CREATE TRIGGER observe_hello_reconcile AFTER DELETE ON locks WHEN OLD.name = 'app:hello' BEGIN INSERT INTO reconcile_probe VALUES (OLD.name); END;",
      );
      // Apps are ordered by name; use a host after hello for the held second app.
      const locks = new SqliteAppLocks(h.store),
        held = await locks.acquire("app:zbravo");
      try {
        const launched = h.launchServe();
        await adminReady(h.admin);
        await eventually(async () =>
          expect(
            h.store.db.query("SELECT name FROM reconcile_probe").all(),
          ).toHaveLength(1),
        );
        await writeFile(join(h.source, "index.html"), "fresh cutover\n");
        await h.commit();
        const result = await h.push();
        expect(result.code).toBe(0);
        expect(launched.ready()).toBe(false);
        const app = h.store.app("hello");
        if (!app) throw new Error("missing app");
        const row = h.store
          .releases(app.id)
          .find((row) => row.status === "live");
        if (!row?.container_id) throw new Error("missing live row");
        const upstream = `127.0.0.1:${(await h.docker.inspectContainer(row.container_id))?.port}`;
        held.release();
        await eventually(async () => expect(launched.ready()).toBe(true));
        const routes = JSON.stringify(
          await (
            await fetch(
              `http://127.0.0.1:${h.admin}/config/apps/http/servers/hoist/routes`,
            )
          ).json(),
        );
        expect(routes).toContain(upstream);
        expect(await (await h.request()).text()).toBe("fresh cutover\n");
        await h.control("apps:destroy", "hello", "--force");
        await h.control("apps:destroy", "zbravo", "--force");
      } finally {
        held.release();
      }
    });
  },
  90000,
);

scenario(
  "foreign container linkage never serves bravo's body at hello",
  async () => {
    await withSSH(async (h) => {
      await h.control("apps:create", "hello");
      expect((await h.push()).code).toBe(0);
      await h.control("apps:create", "bravo");
      const bravo = h.store.app("bravo"),
        hello = h.store.app("hello");
      if (!bravo || !hello) throw new Error("missing apps");
      await writeFile(join(h.source, "index.html"), "BRAVO_SECRET\n");
      const row = reserveRelease(h.store, bravo, "main", "b".repeat(40));
      await new Response(
        await h.docker.buildImage(
          {
            contextDir: h.source,
            tag: row.image,
            labels: { "hoist.app": "bravo", "hoist.release": String(row.id) },
          },
          AbortSignal.timeout(30000),
        ),
      ).text();
      h.store.completeRelease(row.id);
      const built = h.store.releases(bravo.id)[0];
      if (!built) throw new Error("missing bravo release");
      await cutover(
        h.store,
        h.docker,
        new Caddy(h.admin),
        bravo,
        built,
        null,
        async () => null,
        checkHealth,
      );
      const helloRow = h.store
        .releases(hello.id)
        .find((row) => row.status === "live");
      const bravoId = h.store.releases(bravo.id)[0]?.container_id;
      if (!helloRow || !bravoId) throw new Error("missing containers");
      h.store.setReleaseState(helloRow.id, "live", bravoId, "live");
      await h.stopServe();
      await h.startServe();
      expect(h.getLogs()).toContain("ownership does not match");
      await eventually(async () =>
        expect(await (await h.request()).text()).toBe("hello from hoist\n"),
      );
      for (let i = 0; i < 20; i++)
        expect(await (await h.request()).text()).not.toContain("BRAVO_SECRET");
      await eventually(async () => {
        expect(await (await h.request("bravo.example.test")).text()).toBe(
          "BRAVO_SECRET\n",
        );
      });
      expect((await h.docker.inspectContainer(bravoId))?.running).toBe(true);
      await h.control("apps:destroy", "hello", "--force");
      await h.control("apps:destroy", "bravo", "--force");
    });
  },
  90000,
);

scenario(
  "SIGKILLed hook leaves no built candidate after boot reconcile",
  async () => {
    await withSSH(async (h) => {
      await h.control("apps:create", "hello");
      await h.stopServe();
      await writeFile(
        join(h.source, "Dockerfile"),
        'FROM busybox:1.37.0\nEXPOSE 8080\nCMD ["sh","-c","while true; do nc -l -p 8080 >/dev/null; done"]\n',
      );
      const sha = await h.commit(),
        repo = join(h.data, "repos/hello.git");
      await ok([
        "git",
        "--git-dir",
        repo,
        "fetch",
        h.source,
        `${sha}:refs/lab/good`,
      ]);
      const hook = Bun.spawn(
        [process.execPath, cli, "git-hook", "pre-receive", "hello"],
        {
          env: h.env,
          cwd: repo,
          stdin: new Response(`${"0".repeat(40)} ${sha} refs/heads/main\n`),
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const output = new Response(hook.stderr).text();
      try {
        await eventually(async () => {
          const containers = await h.docker.listContainers({
            "hoist.app": "hello",
          });
          expect(containers).toHaveLength(1);
          expect(
            (await h.docker.inspectContainer(containers[0]?.id ?? ""))?.running,
          ).toBe(true);
        }, 30000);
        expect(h.store.lock("app:hello")?.owner_pid).toBe(hook.pid);
        hook.kill("SIGKILL");
        await hook.exited;
        await output;
        await h.startServe();
        const app = h.store.app("hello");
        if (!app) throw new Error("missing app");
        expect(h.store.releases(app.id)[0]?.status).toBe("failed");
        expect(h.getLogs()).toContain("interrupted before cutover");
        expect(await h.docker.listContainers({ "hoist.app": "hello" })).toEqual(
          [],
        );
        expect(h.store.lock("app:hello")).toBeNull();
        await h.control("apps:destroy", "hello", "--force");
      } finally {
        if (hook.exitCode === null) hook.kill("SIGKILL");
        await hook.exited;
        await output;
      }
    });
  },
  90000,
);

scenario(
  "SIGTERM cancels serve waiting on an app lease within five seconds",
  async () => {
    await withSSH(async (h) => {
      await h.control("apps:create", "hello");
      await h.stopServe();
      const locks = new SqliteAppLocks(h.store),
        held = await locks.acquire("app:hello");
      try {
        const launched = h.launchServe();
        await adminReady(h.admin);
        expect(launched.ready()).toBe(false);
        const started = Date.now();
        await Promise.race([
          h.stopServe(),
          Bun.sleep(4500).then(() => {
            throw new Error("shutdown did not cancel lease wait");
          }),
        ]);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(h.store.lock("serve")).toBeNull();
        expect(locks.isLocked("hello")).toBe(true);
      } finally {
        held.release();
      }
      await h.control("apps:destroy", "hello", "--force");
    });
  },
  30000,
);
