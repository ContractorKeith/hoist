import { expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reserveRelease } from "../../src/core/build";
import { eventually } from "./harness";
import { withSSH } from "./ssh";

const scenario = process.env.HOIST_E2E !== undefined ? test : test.skip;
scenario(
  "serves over HTTPS, zero-downtime second push, failed health check keeps old, restart reconciles and destroy cleans everything",
  async () => {
    await withSSH(async (h) => {
      const { store, docker, data, source, control, push, commit, request } = h;
      await control("apps:create", "hello");
      const first = await push();
      expect(first.code).toBe(0);
      const app = store.app("hello");
      if (!app) throw new Error("Missing app");
      const rows = () => store.releases(app.id);
      const v1 = rows()[0];
      if (!v1?.container_id) throw new Error("Missing live v1");
      expect(v1.status).toBe("live");
      await eventually(async () => {
        const response = await request();
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("hello from hoist\n");
      });
      const info = await docker.inspectContainer(v1.container_id);
      expect(info?.running).toBe(true);
      // Inspect Docker's actual binding as well as the external TLS response.
      const raw = await fetch(
        `http://localhost/v1.47/containers/${v1.container_id}/json`,
        {
          unix: (process.env.DOCKER_HOST ?? "/var/run/docker.sock").replace(
            /^unix:\/\//,
            "",
          ),
        },
      );
      const inspected = (await raw.json()) as {
        NetworkSettings: {
          Ports: Record<string, { HostIp: string; HostPort: string }[]>;
        };
      };
      expect(
        Object.values(inspected.NetworkSettings.Ports)
          .flat()
          .every(
            (binding) =>
              binding.HostIp === "127.0.0.1" && Number(binding.HostPort) > 1024,
          ),
      ).toBe(true);
      await writeFile(join(source, "index.html"), "second release\n");
      await commit();
      let requesting = true,
        count = 0;
      const errors: unknown[] = [];
      const loop = (async () => {
        while (requesting) {
          try {
            const response = await request();
            if (response.status !== 200) errors.push(response.status);
            await response.text();
            count++;
          } catch (error) {
            errors.push(error);
          }
          await Bun.sleep(5);
        }
      })();
      let second: Awaited<ReturnType<typeof push>>;
      try {
        second = await push();
      } finally {
        requesting = false;
        await loop;
      }
      expect(second.code).toBe(0);
      expect(count).toBeGreaterThan(0);
      expect(errors).toEqual([]);
      console.log(
        `Cutover request loop: ${count} responses, zero non-200 responses.`,
      );
      expect(rows()[0]?.status).toBe("stopped");
      expect(rows()[1]?.status).toBe("live");
      expect(await docker.inspectContainer(v1.container_id)).toBeNull();
      expect(await (await request()).text()).toBe("second release\n");
      // Same listening port, but every health response is HTTP 500.
      await writeFile(
        join(source, "Dockerfile"),
        'FROM alpine:3.21\nEXPOSE 8080\nCMD ["sh", "-c", "while true; do printf \'HTTP/1.1 500 Internal Server Error\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n\' | nc -l -p 8080; done"]\n',
      );
      await commit();
      const failed = await push();
      expect(failed.code).not.toBe(0);
      expect(failed.output).toContain(
        "Health check GET / failed after 30 s: HTTP 500",
      );
      expect(rows()[1]?.status).toBe("live");
      expect(rows()[2]?.status).toBe("failed");
      expect(await (await request()).text()).toBe("second release\n");
      expect(
        await docker.listContainers({ "hoist.app": "hello" }),
      ).toHaveLength(1);
      await h.stopServe();
      const stale = reserveRelease(store, app, "main", "c".repeat(40));
      // A separate image with the exact building-release labels exercises the reaper.
      const build = await docker.buildImage(
        {
          contextDir: source,
          tag: stale.image,
          labels: { "hoist.app": app.name, "hoist.release": String(stale.id) },
        },
        AbortSignal.timeout(30000),
      );
      await new Response(build).text();
      const live = rows()[1];
      if (!live?.container_id) throw new Error("Missing v2");
      await docker.removeContainer(live.container_id);
      const orphan = await docker.createContainer({
        image: live.image,
        labels: { "hoist.app": app.name },
        port: 8080,
        publishPort: "",
      });
      await docker.startContainer(orphan);
      await h.startServe();
      expect(rows().find((row) => row.id === stale.id)?.status).toBe("failed");
      expect(
        await docker.listImages({
          "hoist.app": app.name,
          "hoist.release": String(stale.id),
        }),
      ).toEqual([]);
      expect(await docker.inspectContainer(orphan)).toBeNull();
      await eventually(async () => {
        expect(await (await request()).text()).toBe("second release\n");
      });
      expect(rows()[1]?.container_id).not.toBe(live.container_id);
      const supervisor = h.getServer();
      if (!supervisor) throw new Error("Missing supervisor");
      const childrenPath = `/proc/${supervisor.pid}/task/${supervisor.pid}/children`;
      const children = (await readFile(childrenPath, "utf8"))
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      expect(children).toHaveLength(1);
      process.kill(Number(children[0]), "SIGKILL");
      await eventually(async () => {
        const next = (await readFile(childrenPath, "utf8")).trim();
        expect(next).not.toBe(children[0]);
        expect(await (await request()).text()).toBe("second release\n");
      });
      const redirect = await fetch(`http://127.0.0.1:${h.http}/`, {
        headers: { Host: app.domain },
        redirect: "manual",
      });
      expect(redirect.status).toBe(308);
      await redirect.body?.cancel();
      console.log(
        `README walkthrough: HOIST_DIR=<private> HOIST_TLS=internal HOIST_HTTP_PORT=${h.http} HOIST_HTTPS_PORT=${h.https} HOIST_CADDY_ADMIN_PORT=${h.admin} hoist serve; ssh … hoist apps:create hello; git remote add hoist ssh://…/hello.git; git push hoist main; HTTPS Host: hello.example.test, tls.ca=root.crt -> 200, second release`,
      );
      console.log(
        `Internal CA loaded: ${(await readFile(join(data, "caddy/pki/authorities/local/root.crt"), "utf8")).startsWith("-----BEGIN CERTIFICATE-----")}`,
      );
      await control("apps:destroy", "hello", "--force");
      expect(store.apps()).toEqual([]);
      expect(rows()).toEqual([]);
      expect(await docker.listContainers({ "hoist.app": app.name })).toEqual(
        [],
      );
      expect(await docker.listImages({ "hoist.app": app.name })).toEqual([]);
      for (const path of ["repos/hello.git", "releases/hello"])
        expect(await stat(join(data, path)).catch(() => null)).toBeNull();
      const routes = await (
        await fetch(
          `http://127.0.0.1:${h.admin}/config/apps/http/servers/hoist/routes`,
        )
      ).json();
      expect(routes).toEqual([]);
    });
  },
  240000,
);

scenario(
  "a disconnected pusher still completes cutover server-side",
  async () => {
    await withSSH(async (h) => {
      await h.control("apps:create", "hello");
      const dockerfile = await readFile(join(h.source, "Dockerfile"), "utf8");
      await writeFile(
        join(h.source, "Dockerfile"),
        dockerfile.replace(
          "FROM busybox:1.37.0",
          "FROM busybox:1.37.0\nRUN sleep 3",
        ),
      );
      await h.commit();
      const client = Bun.spawn(["git", "push", "hoist", "main"], {
        cwd: h.source,
        env: h.pushEnv,
        stdout: "ignore",
        stderr: "ignore",
      });
      await eventually(async () => {
        const app = h.store.app("hello");
        expect(app && h.store.releases(app.id)[0]?.status).toBe("building");
      });
      client.kill("SIGHUP");
      await client.exited;
      await eventually(async () => {
        const app = h.store.app("hello");
        expect(app && h.store.releases(app.id)[0]?.status).toBe("live");
      }, 30000);
      await eventually(async () => {
        expect(await (await h.request()).text()).toBe("hello from hoist\n");
      });
      await h.control("apps:destroy", "hello", "--force");
    });
  },
  90000,
);
