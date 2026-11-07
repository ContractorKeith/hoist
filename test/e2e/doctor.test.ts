import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { DashboardStore } from "../../src/store/dashboard";
import { command, ok, withSSH } from "./ssh";

test.skipIf(process.env.HOIST_E2E !== "1")(
  "doctor repairs hooks and reports an orphan until app destruction",
  async () => {
    await withSSH(async (h) => {
      new DashboardStore(h.store.db).savePassword(
        await Bun.password.hash("doctor-test-password"),
      );
      await h.control("apps:create", h.appName);
      expect((await h.push()).code).toBe(0);
      const hook = join(h.data, "repos", `${h.appName}.git/hooks/pre-receive`);
      const post = join(h.data, "repos", `${h.appName}.git/hooks/post-receive`);
      for (const path of [hook, post])
        await Bun.write(path, "#!/bin/sh\nexec /old/hoist\n");
      const app = h.store.app(h.appName);
      if (!app) throw new Error("Missing app");
      const image = h.store.releases(app.id)[0]?.image;
      if (!image) throw new Error("Missing image");
      const orphan = await h.docker.createContainer({
        image,
        labels: { "hoist.app": h.appName, "hoist.release": "999999" },
        port: 8080,
        publishPort: "",
      });
      const run = () =>
        command(
          [
            process.execPath,
            resolve(import.meta.dir, "../../src/cli/index.ts"),
            "doctor",
            "--json",
          ],
          {
            env: h.env,
          },
        );
      try {
        const result = await run();
        expect(result.code).toBe(1);
        const checks = JSON.parse(result.stdout);
        const imageCheck = checks.find(
          (r: { check: string }) => r.check === "Orphan images",
        );
        expect(imageCheck.status, imageCheck.message).toBe("ok");
        expect(
          checks.find((r: { check: string }) => r.check === "Orphan containers")
            .message,
        ).toContain(orphan);
        const stale = `hoist/${h.appName}:stale`;
        try {
          await ok(["docker", "tag", image, stale]);
          const imagesCheck = async () =>
            JSON.parse((await run()).stdout).find(
              (r: { check: string }) => r.check === "Orphan images",
            );
          // A second tag on a retained image is still owned.
          expect((await imagesCheck()).status).toBe("ok");
          const live = h.store
            .releases(app.id)
            .find((r) => r.status === "live");
          if (!live?.container_id) throw new Error("Missing live container");
          // A distinct top-level image carrying the stale tag is untracked.
          await ok([
            "docker",
            "commit",
            "--change",
            "LABEL hoist.orphan=true",
            live.container_id,
            stale,
          ]);
          const orphanImage = await imagesCheck();
          expect(orphanImage.status).toBe("error");
          expect(orphanImage.message).toContain(stale);
          await ok(["docker", "rmi", stale]);
          expect((await imagesCheck()).status).toBe("ok");
        } finally {
          await command(["docker", "rmi", stale]);
        }
        for (const path of [hook, post])
          expect(await Bun.file(path).text()).toContain(
            `exec '${process.execPath}' '${resolve(import.meta.dir, "../../src/cli/index.ts")}' git-hook`,
          );
        await h.control("apps:destroy", h.appName, "--force");
        const after = await run();
        if (after.code) throw new Error(after.output);
        expect(after.code).toBe(0);
        const clean = JSON.parse(after.stdout);
        for (const name of [
          "Orphan containers",
          "Orphan images",
          "Orphan routes",
        ])
          expect(
            clean.find((r: { check: string }) => r.check === name).status,
          ).toBe("ok");
      } finally {
        await h.docker.removeContainer(orphan).catch(() => {});
      }
    });
  },
  120000,
);
