import { expect, test } from "bun:test";
import { checkVolumes } from "../../src/cli/doctor-volumes";
import { command, withSSH } from "./ssh";

const scenario = process.env.HOIST_E2E !== undefined ? test : test.skip;
scenario(
  "volume ownership and foreign references refuse destruction before touching the app; doctor filters labels",
  async () => {
    await withSSH(async (h) => {
      const name = `hoist-${h.appName}-data`,
        unlabelled = `hoist-${h.appName}-registry-data`;
      let foreign: string | undefined;
      const run = (...args: string[]) =>
        command([...h.ssh, h.remote, "hoist", ...args]);
      try {
        await h.control("apps:create", h.appName);
        expect((await h.push()).code).toBe(0);
        await h.control("apps:set", h.appName, "volume=/data");
        const app = h.store.app(h.appName);
        if (!app) throw new Error("Missing app");
        await h.docker.createVolume(name, {});
        const refused = await run("apps:destroy", h.appName, "--force");
        expect(refused.code).toBe(1);
        expect(refused.output).toContain("ownership does not match");
        expect((await h.request()).status).toBe(200);
        expect(h.store.app(h.appName)).not.toBeNull();
        await h.docker.removeVolume(name);
        await h.docker.createVolume(name, {
          "hoist.app": app.name,
          "hoist.app-id": String(app.id),
        });
        await h.docker.createVolume(unlabelled, {});
        expect(
          (await h.docker.listVolumes(["hoist.app"])).some(
            (v) => v.name === unlabelled,
          ),
        ).toBe(false);
        expect(await checkVolumes(h.store, h.docker)).toContain(
          `${name} at /data`,
        );
        const live = h.store.releases(app.id).find((r) => r.status === "live");
        if (!live) throw new Error("Missing release");
        // This test owns the simulated foreign container; hoist must leave it alone.
        foreign = await h.docker.createContainer({
          image: live.image,
          labels: { "hoist.test": h.appName },
          port: 8080,
          publishPort: "",
          volume: { name, path: "/data" },
        });
        for (const verb of ["apps:destroy", "apps:volume:rm"]) {
          const result = await run(verb, h.appName, "--force");
          expect(result.code).toBe(1);
          expect(result.output).toContain(
            `Stop containers using ${name}, then retry`,
          );
          expect((await h.request()).status).toBe(200);
        }
        await h.docker.removeContainer(foreign);
        foreign = undefined;
        await h.control("apps:volume:rm", h.appName, "--force");
        await h.control("apps:destroy", h.appName, "--force");
      } finally {
        if (foreign) await h.docker.removeContainer(foreign);
        for (const c of await h.docker.listContainers({
          "hoist.app": h.appName,
        }))
          await h.docker.removeContainer(c.id);
        for (const n of [name, unlabelled])
          if ((await h.docker.listVolumes()).some((v) => v.name === n))
            await h.docker.removeVolume(n);
      }
    });
  },
  120000,
);
