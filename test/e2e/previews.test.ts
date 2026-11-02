import { expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eventually } from "./harness";
import { assertPreviewGone } from "./preview-assertions";
import { command, ok, withSSH } from "./ssh";

const scenario = process.env.HOIST_E2E !== undefined ? test : test.skip;
scenario(
  "preview hosts, collisions, reconcile, branch delete, explicit destroy and app cleanup",
  async () => {
    await withSSH(async (h) => {
      const { appName } = h;
      await h.control("apps:create", appName);
      expect((await h.push()).code).toBe(0);
      const app = h.store.app(appName);
      if (!app) throw new Error("Missing app");
      const push = (ref: string) =>
        command(["git", "push", "hoist", ref], {
          cwd: h.source,
          env: h.pushEnv,
        });
      await writeFile(join(h.source, "index.html"), "preview body\n");
      await h.commit();
      expect((await push("HEAD:refs/heads/feature-x")).code).toBe(0);
      await eventually(async () => {
        expect(
          await (await h.request(`feature-x.${appName}.example.test`)).text(),
        ).toBe("preview body\n");
        expect(await (await h.request()).text()).toBe("hello from hoist\n");
      });
      const listed = await h.control("previews:list", appName, "--json");
      expect(JSON.parse(listed.stdout)).toMatchObject([
        { branch: "feature-x", slug: "feature-x" },
      ]);
      expect((await push("HEAD:refs/heads/Feature/X-Y")).code).toBe(0);
      await eventually(async () => {
        expect(
          await (await h.request(`feature-x-y.${appName}.example.test`)).text(),
        ).toBe("preview body\n");
      });
      const collision = await push("HEAD:refs/heads/feature-x-y");
      expect(collision.code).not.toBe(0);
      expect(collision.output).toContain("Feature/X-Y");
      // Recovery must not overwrite the bare domain with a preview.
      await h.stopServe();
      const preview = h.store
        .releases(app.id)
        .find((r) => r.branch === "feature-x");
      if (!preview?.container_id) throw new Error("Missing preview");
      await h.docker.removeContainer(preview.container_id);
      await h.startServe();
      await eventually(async () => {
        expect(
          await (await h.request(`feature-x.${appName}.example.test`)).text(),
        ).toBe("preview body\n");
        expect(await (await h.request()).text()).toBe("hello from hoist\n");
      });
      const images = h.store
        .releases(app.id)
        .filter((r) => r.branch === "feature-x");
      const hookPath = join(h.data, `repos/${appName}.git/hooks/pre-receive`);
      const originalHook = await readFile(hookPath, "utf8");
      try {
        // Run Hoist's pre-receive, then reject the Git transaction.
        await writeFile(
          hookPath,
          `${originalHook.replace("\nexec ", "\n")}\nexit 1\n`,
        );
        expect((await push(":feature-x")).code).not.toBe(0);
        expect(
          h.store.previews(app.id).some((p) => p.branch === "feature-x"),
        ).toBe(true);
        expect(
          await (await h.request(`feature-x.${appName}.example.test`)).text(),
        ).toBe("preview body\n");
      } finally {
        await writeFile(hookPath, originalHook);
      }
      const started = Date.now();
      expect((await push(":feature-x")).code).toBe(0);
      const pushMs = Date.now() - started;
      // Rows are deleted last, after all preview resources have been removed.
      await eventually(async () => {
        expect(
          h.store.previews(app.id).some((p) => p.branch === "feature-x"),
        ).toBe(false);
        expect(
          h.store.releases(app.id).some((r) => r.branch === "feature-x"),
        ).toBe(false);
      }, 10000);
      const teardownMs = Date.now() - started;
      expect(teardownMs).toBeLessThan(10000);
      // Resource verification queries are outside the teardown deadline.
      await Promise.all([
        command([
          "git",
          "--git-dir",
          join(h.data, `repos/${appName}.git`),
          "rev-parse",
          "--verify",
          "refs/heads/feature-x",
        ]).then((result) => expect(result.code).not.toBe(0)),
        assertPreviewGone(h, app, "feature-x", "feature-x", images),
      ]);
      console.log(
        `Preview deletion: push completed in ${pushMs} ms; cleanup completed in ${teardownMs} ms from delete push.`,
      );
      const xyImages = h.store
        .releases(app.id)
        .filter((r) => r.branch === "Feature/X-Y");
      await h.control("previews:destroy", appName, "feature-x-y");
      await assertPreviewGone(h, app, "Feature/X-Y", "feature-x-y", xyImages);
      const mainDelete = await push(":main");
      expect(mainDelete.code).not.toBe(0);
      expect(mainDelete.output).toContain("main branch");
      // Changing the main branch also reclassifies existing release chains.
      await h.control("apps:set", appName, "branch=master");
      expect((await push("HEAD:refs/heads/master")).code).toBe(0);
      expect(h.store.app(appName)?.main_branch).toBe("master");
      await eventually(async () => {
        expect(await (await h.request()).text()).toBe("preview body\n");
        expect(
          await (await h.request(`main.${appName}.example.test`)).text(),
        ).toBe("hello from hoist\n");
      });
      await h.control("apps:destroy", appName, "--force");
      expect(await h.docker.listContainers({ "hoist.app": appName })).toEqual(
        [],
      );
      expect(await h.docker.listImages({ "hoist.app": appName })).toEqual([]);
      expect(
        await (
          await fetch(
            `http://127.0.0.1:${h.admin}/config/apps/http/servers/hoist/routes`,
          )
        ).json(),
      ).toHaveLength(1);
    });
  },
  180000,
);

scenario(
  "timer sweeps a two-day-old preview with a one-day TTL and keeps a fresh preview",
  async () => {
    await withSSH(async (h) => {
      const { appName } = h;
      await h.control("apps:create", appName);
      expect((await h.push()).code).toBe(0);
      for (const branch of ["idle", "fresh"])
        await ok(["git", "push", "hoist", `HEAD:refs/heads/${branch}`], {
          cwd: h.source,
          env: h.pushEnv,
        });
      const app = h.store.app(appName);
      if (!app) throw new Error("Missing app");
      const old = h.store.releases(app.id).find((r) => r.branch === "idle");
      if (!old) throw new Error("Missing idle preview");
      h.store.upsertPreview({
        app_id: app.id,
        branch: "idle",
        slug: "idle",
        last_push_at: new Date(Date.now() - 2 * 86400000).toISOString(),
      });
      await h.stopServe();
      h.env.HOIST_PREVIEW_TTL_DAYS = "1";
      h.env.HOIST_SWEEP_INTERVAL_MS = "1000";
      await h.startServe();
      await eventually(async () => {
        expect(h.store.previews(app.id).map((p) => p.branch)).toEqual([
          "fresh",
        ]);
      }, 60000);
      expect(h.store.releases(app.id).some((r) => r.branch === "idle")).toBe(
        false,
      );
      expect(
        await h.docker.listContainers({
          "hoist.app": appName,
          "hoist.branch": "idle",
        }),
      ).toEqual([]);
      expect(
        await h.docker.listImages({
          "hoist.app": appName,
          "hoist.release": String(old.id),
        }),
      ).toEqual([]);
      expect(
        await stat(join(h.data, `releases/${appName}/idle`)).catch(() => null),
      ).toBeNull();
      expect(h.getLogs()).toContain(`Swept preview ${appName} idle`);
      try {
        await eventually(async () => {
          expect((await h.request()).status).toBe(200);
          expect(
            (await h.request(`fresh.${appName}.example.test`)).status,
          ).toBe(200);
        });
      } catch (error) {
        console.error(h.getLogs());
        throw error;
      }
      const routes = JSON.stringify(
        await (
          await fetch(
            `http://127.0.0.1:${h.admin}/config/apps/http/servers/hoist/routes`,
          )
        ).json(),
      );
      expect(routes).not.toContain(`idle.${appName}.example.test`);
    });
  },
  90000,
);
