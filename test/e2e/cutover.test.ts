import { expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reserveRelease } from "../../src/core/build";
import { eventually, highPort } from "./harness";
import { command, ok, withSSH } from "./ssh";

const scenario = process.env.HOIST_E2E !== undefined ? test : test.skip;
scenario(
  "serves over HTTPS, zero-downtime second push, failed health check keeps old, restart reconciles and destroy cleans everything",
  async () => {
    await withSSH(async (h) => {
      const { appName } = h;
      const { store, docker, data, source, control, push, commit, request } = h;
      await control("apps:create", appName);
      const first = await push();
      expect(first.code).toBe(0);
      const app = store.app(appName);
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
      const bodies = new Set<string>();
      const loops = Array.from({ length: 4 }, async () => {
        while (requesting) {
          try {
            const response = await request();
            if (response.status !== 200) errors.push(response.status);
            bodies.add(await response.text());
            count++;
          } catch (error) {
            errors.push(error);
          }
        }
      });
      await eventually(async () => {
        expect(bodies.has("hello from hoist\n")).toBe(true);
      });
      let second: Awaited<ReturnType<typeof push>>;
      try {
        second = await push();
        await eventually(async () => {
          expect(count).toBeGreaterThanOrEqual(200);
          expect(bodies.has("second release\n")).toBe(true);
        });
      } finally {
        requesting = false;
        await Promise.all(loops);
      }
      expect(second.code).toBe(0);
      expect(count).toBeGreaterThanOrEqual(200);
      expect(bodies).toEqual(
        new Set(["hello from hoist\n", "second release\n"]),
      );
      expect(errors).toEqual([]);
      console.log(
        `Cutover request loop: ${count} responses across 4 loops, both bodies observed, zero non-200 responses.`,
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
      const failedLog = await control("logs", appName, "--release", "v3");
      expect(failedLog.stdout).toContain(
        "Health check GET / failed after 30 s: HTTP 500",
      );
      expect(await (await request()).text()).toBe("second release\n");
      expect(
        await docker.listContainers({ "hoist.app": appName }),
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
        // Docker inherits image labels, so explicitly name an absent release.
        labels: { "hoist.app": app.name, "hoist.release": "999999" },
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
        `README walkthrough: HOIST_DIR=<private> HOIST_TLS=internal HOIST_HTTP_PORT=${h.http} HOIST_HTTPS_PORT=${h.https} HOIST_CADDY_ADMIN_PORT=${h.admin} hoist serve; ssh … hoist apps:create ${appName}; git remote add hoist ssh://…/${appName}.git; git push hoist main; HTTPS Host: ${appName}.example.test, tls.ca=root.crt -> 200, second release`,
      );
      console.log(
        `Internal CA loaded: ${(await readFile(join(data, "caddy/pki/authorities/local/root.crt"), "utf8")).startsWith("-----BEGIN CERTIFICATE-----")}`,
      );
      await control("apps:destroy", appName, "--force");
      expect(store.apps()).toEqual([]);
      expect(rows()).toEqual([]);
      expect(await docker.listContainers({ "hoist.app": app.name })).toEqual(
        [],
      );
      expect(await docker.listImages({ "hoist.app": app.name })).toEqual([]);
      for (const path of [`repos/${appName}.git`, `releases/${appName}`])
        expect(await stat(join(data, path)).catch(() => null)).toBeNull();
      const routes = await (
        await fetch(
          `http://127.0.0.1:${h.admin}/config/apps/http/servers/hoist/routes`,
        )
      ).json();
      expect(JSON.stringify(routes)).toContain("hoist.example.test");
      expect(routes).toHaveLength(1);
    });
  },
  240000,
);

scenario(
  "a disconnected pusher still completes cutover server-side",
  async () => {
    await withSSH(async (h) => {
      const { appName } = h;
      await h.control("apps:create", appName);
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
        const app = h.store.app(appName);
        expect(app && h.store.releases(app.id)[0]?.status).toBe("building");
      });
      client.kill("SIGHUP");
      await client.exited;
      await eventually(async () => {
        const app = h.store.app(appName);
        expect(app && h.store.releases(app.id)[0]?.status).toBe("live");
      }, 30000);
      await eventually(async () => {
        expect(await (await h.request()).text()).toBe("hello from hoist\n");
      });
      await h.control("apps:destroy", appName, "--force");
    });
  },
  90000,
);

scenario(
  "two concurrent main pushes serialize cutover and leave exactly one live container",
  async () => {
    await withSSH(async (h) => {
      const { appName } = h;
      await h.control("apps:create", appName);
      expect((await h.push()).code).toBe(0);
      const clones = [join(h.root, "clone-one"), join(h.root, "clone-two")];
      const remote = (
        await ok(["git", "remote", "get-url", "hoist"], { cwd: h.source })
      ).stdout.trim();
      for (const [index, clone] of clones.entries()) {
        await ok(["git", "clone", h.source, clone]);
        await ok(["git", "remote", "add", "hoist", remote], { cwd: clone });
        await writeFile(join(clone, "index.html"), `concurrent ${index}\n`);
        await ok(["git", "add", "."], { cwd: clone });
        await ok(
          [
            "git",
            "-c",
            "user.name=ContractorKeith",
            "-c",
            "user.email=ContractorKeith@users.noreply.github.com",
            "commit",
            "-m",
            `clone ${index}`,
          ],
          { cwd: clone },
        );
      }
      const results = await Promise.all(
        clones.map((clone) =>
          command(["git", "push", "hoist", "main"], {
            cwd: clone,
            env: h.pushEnv,
          }),
        ),
      );
      for (const result of results) {
        expect(result.output).toMatch(
          /Live: https:|branch main moved|branch moved|fetch first|failed to push|stale info/,
        );
        console.log(
          `Concurrent push exit ${result.code}: ${result.output
            .split("\n")
            .filter((line) => /Live:|branch .*moved|rejected/.test(line))
            .join("; ")}`,
        );
      }
      expect(results.some((result) => result.code === 0)).toBe(true);
      const app = h.store.app(appName);
      if (!app) throw new Error("Missing app");
      const releases = h.store.releases(app.id),
        live = releases.filter((row) => row.status === "live");
      expect(live).toHaveLength(1);
      const containers = await h.docker.listContainers({
        "hoist.app": appName,
      });
      expect(containers).toHaveLength(1);
      expect(containers[0]?.id).toBe(live[0]?.container_id ?? undefined);
      expect(
        releases.filter(
          (row) => row.status === "built" || row.status === "building",
        ),
      ).toEqual([]);
      await h.control("apps:destroy", appName, "--force");
    });
  },
  180000,
);

scenario(
  "a health path returning HTTP 302 fails the push",
  async () => {
    await withSSH(async (h) => {
      const { appName } = h;
      await h.control("apps:create", appName, "--health-path", "/");
      await writeFile(
        join(h.source, "Dockerfile"),
        'FROM busybox:1.37.0\nEXPOSE 8080\nCMD ["sh", "-c", "while true; do printf \'HTTP/1.1 302 Found\\r\\nLocation: /ready\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n\' | nc -l -p 8080; done"]\n',
      );
      await h.commit();
      const result = await h.push();
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("HTTP 302");
      expect(result.output).toContain("expected HTTP 2xx");
      const app = h.store.app(appName);
      if (!app) throw new Error("Missing app");
      expect(h.store.releases(app.id)[0]?.status).toBe("failed");
      expect(await h.docker.listContainers({ "hoist.app": appName })).toEqual(
        [],
      );
      await h.stopServe();
      const destroyed = await h.control("apps:destroy", appName, "--force");
      expect(destroyed.output).toContain(
        "Caddy not reachable; routes are rebuilt from the store when hoist serve starts",
      );
      expect(h.store.apps()).toEqual([]);
    });
  },
  120000,
);

scenario(
  "Caddy bind failures exit serve after five fast crashes with stderr",
  async () => {
    await withSSH(async (h) => {
      const occupied = Bun.serve({
        hostname: "0.0.0.0",
        port: 0,
        fetch: () => new Response("occupied"),
      });
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../../src/cli/index.ts"),
          "serve",
        ],
        {
          env: {
            ...h.env,
            HOIST_DIR: join(h.root, "crash-data"),
            HOIST_HTTPS_PORT: String(occupied.port),
            HOIST_DASHBOARD_PORT: String(await highPort()),
            HOIST_CADDY_ADMIN_PORT: String(await highPort()),
            HOIST_HTTP_PORT: String(await highPort()),
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const output = new Response(child.stderr).text();
      try {
        const code = await Promise.race([
          child.exited,
          Bun.sleep(20000).then(() => {
            throw new Error("serve kept crash-looping");
          }),
        ]);
        const stderr = await output;
        expect(code).not.toBe(0);
        expect(stderr).toContain("five consecutive times under 10 s");
        expect(stderr).toContain("address already in use");
        expect(stderr).toContain("Caddy exited with code");
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
        await output;
        await occupied.stop(true);
      }
    });
  },
  60000,
);
