import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, withSSH } from "./ssh";

const scenario = process.env.HOIST_E2E !== undefined ? test : test.skip;
scenario(
  "set volume on existing releases, roll back to a pre-volume image, and restore with a new app ID",
  async () => {
    await withSSH(async (h) => {
      const name = `hoist-${h.appName}-data`;
      try {
        await h.control("apps:create", h.appName);
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
        expect((await h.push()).code).toBe(0);
        const starts = async (count: number) =>
          expect(await (await h.request(undefined, "/starts")).text()).toBe(
            "start\n".repeat(count),
          );
        await starts(1);
        await h.control("apps:set", h.appName, "volume=/data");
        await starts(1);
        expect(
          (await h.docker.listVolumes()).some((v) => v.name === name),
        ).toBe(false);
        await writeFile(join(h.source, "index.html"), "with volume\n");
        await h.commit();
        expect((await h.push()).code).toBe(0);
        // Setting a mount does not migrate the old container's one line.
        await starts(1);
        await h.control("rollback", h.appName, "v1");
        await starts(2);
        const info = JSON.parse(
          (await h.control("apps:info", h.appName, "--json")).stdout,
        );
        const live = info.releases.find(
          (r: { status: string }) => r.status === "live",
        );
        const inspected = JSON.parse(
          (await ok(["docker", "inspect", live.container_id])).stdout,
        )[0];
        expect(inspected.Mounts).toContainEqual(
          expect.objectContaining({
            Name: name,
            Destination: "/data",
            RW: true,
          }),
        );
        const backup = [
          "docker",
          "run",
          "--rm",
          "-v",
          `${name}:/data`,
          "-v",
          `${h.root}:/backup`,
          "alpine:3.21",
          "tar",
          "czf",
          "/backup/app.tgz",
          "-C",
          "/data",
          ".",
        ];
        await ok(backup);
        await h.control(
          "apps:destroy",
          h.appName,
          "--force",
          "--delete-volume",
        );
        await h.control("apps:create", `${h.appName}-keeper`);
        await h.control("apps:create", h.appName, "--volume", "/data");
        const restored = JSON.parse(
          (await h.control("apps:info", h.appName, "--json")).stdout,
        );
        expect(restored.id).not.toBe(info.id);
        // This is the documented restore procedure using the new apps:info ID.
        await ok([
          "docker",
          "volume",
          "create",
          "--label",
          `hoist.app=${h.appName}`,
          "--label",
          `hoist.app-id=${restored.id}`,
          name,
        ]);
        await ok([
          "docker",
          "run",
          "--rm",
          "-v",
          `${name}:/data`,
          "-v",
          `${h.root}:/backup:ro`,
          "alpine:3.21",
          "tar",
          "xzf",
          "/backup/app.tgz",
          "-C",
          "/data",
        ]);
        const pushed = await h.push();
        expect(pushed.code, pushed.output).toBe(0);
        await starts(3);
        await h.control(
          "apps:destroy",
          h.appName,
          "--force",
          "--delete-volume",
        );
      } finally {
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
