import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { command, ok, withSSH } from "./ssh";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}

const scenario = process.env.HOIST_E2E !== undefined ? test : test.skip;
scenario(
  "app volume survives pushes, rollback, restart, pruning and recovery; previews stay isolated",
  async () => {
    await withSSH(async (h) => {
      const name = `hoist-${h.appName}-data`;
      try {
        await h.control("apps:create", h.appName, "--volume", "/data");
        await writeFile(
          join(h.source, "Dockerfile"),
          `FROM busybox:1.37.0
WORKDIR /www
COPY index.html .
EXPOSE 8080
CMD ["sh", "-c", "mkdir -p /data; echo start >> /data/starts; cp /data/starts /www/starts; exec httpd -f -p 8080 -h /www"]
`,
        );
        await h.commit();
        const starts = async (count: number) =>
          expect(await (await h.request(undefined, "/starts")).text()).toBe(
            "start\n".repeat(count),
          );
        expect((await h.push()).code).toBe(0);
        await starts(1);
        await writeFile(join(h.source, "index.html"), "second\n");
        await h.commit();
        expect((await h.push()).code).toBe(0);
        await starts(2);
        await h.control("rollback", h.appName, "v1");
        await starts(3);
        await h.control("apps:set", h.appName, "retention=1");
        await h.control("restart", h.appName);
        await starts(4);
        await h.stopServe();
        const app = required(h.store.app(h.appName));
        const live = required(
          h.store.releases(app.id).findLast((r) => r.status === "live"),
        );
        await h.docker.stopContainer(required(live.container_id));
        await h.startServe();
        await starts(5);
        const refused = await command([
          ...h.ssh,
          h.remote,
          "hoist",
          "apps:volume:rm",
          h.appName,
          "--force",
        ]);
        expect(refused.code).toBe(1);
        expect(refused.output).toContain("409");
        const info = JSON.parse(
          (await h.control("apps:info", h.appName, "--json")).stdout,
        );
        expect(info.volume_name).toBe(name);
        const branchChange = await command([
          ...h.ssh,
          h.remote,
          "hoist",
          "apps:set",
          h.appName,
          "branch=preview",
        ]);
        expect(branchChange.code).toBe(1);
        expect(branchChange.output).toContain("live production release");
        const pushed = await command(
          ["git", "push", "hoist", "HEAD:refs/heads/preview"],
          { cwd: h.source, env: h.pushEnv },
        );
        expect(pushed.code, pushed.output).toBe(0);
        const preview = required(
          h.store.releases(app.id).find((r) => r.branch === "preview"),
        );
        const inspected = JSON.parse(
          (await ok(["docker", "inspect", required(preview.container_id)]))
            .stdout,
        )[0];
        expect(inspected.Mounts).toEqual([]);
        await starts(5);
        const volume = required(
          (await h.docker.listVolumes()).find((v) => v.name === name),
        );
        expect(volume.labels["hoist.app-id"]).toBe(String(app.id));
        const kept = await command([
          ...h.ssh,
          h.remote,
          "hoist",
          "apps:destroy",
          h.appName,
          "--force",
        ]);
        expect(kept.code).toBe(1);
        expect(kept.output).toContain("--delete-volume");
        expect(h.store.app(h.appName)).not.toBeNull();
        const destroyed = await h.control(
          "apps:destroy",
          h.appName,
          "--force",
          "--delete-volume",
        );
        expect(destroyed.output).toContain(`Destroying volume ${name}`);
        expect(
          (await h.docker.listVolumes()).some((v) => v.name === name),
        ).toBe(false);
        // An unused configured volume can be explicitly removed and its path changed.
        await h.control("apps:create", h.appName, "--volume", "/data");
        await h.docker.createVolume(name, {
          "hoist.app": h.appName,
          "hoist.app-id": String(required(h.store.app(h.appName)).id),
        });
        await h.control("apps:volume:rm", h.appName, "--force");
        expect(h.store.app(h.appName)?.volume_path).toBeNull();
        await h.control("apps:set", h.appName, "volume=/other");
      } finally {
        // Keep failure cleanup scoped to this fixture's own resources.
        for (const c of await h.docker.listContainers({
          "hoist.app": h.appName,
        }))
          await h.docker.removeContainer(c.id);
        if ((await h.docker.listVolumes()).some((v) => v.name === name))
          await h.docker.removeVolume(name);
      }
    });
  },
  120000,
);
