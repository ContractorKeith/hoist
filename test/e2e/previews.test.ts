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
      await h.control("apps:create", "hello");
      expect((await h.push()).code).toBe(0);
      const app = h.store.app("hello");
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
          await (await h.request("feature-x.hello.example.test")).text(),
        ).toBe("preview body\n");
        expect(await (await h.request()).text()).toBe("hello from hoist\n");
      });
      const listed = await h.control("previews:list", "hello", "--json");
      expect(JSON.parse(listed.stdout)).toMatchObject([
        { branch: "feature-x", slug: "feature-x" },
      ]);
      expect((await push("HEAD:refs/heads/Feature/X-Y")).code).toBe(0);
      await eventually(async () => {
        expect(
          await (await h.request("feature-x-y.hello.example.test")).text(),
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
          await (await h.request("feature-x.hello.example.test")).text(),
        ).toBe("preview body\n");
        expect(await (await h.request()).text()).toBe("hello from hoist\n");
      });
      const images = h.store
        .releases(app.id)
        .filter((r) => r.branch === "feature-x");
      const hookPath = join(h.data, "repos/hello.git/hooks/pre-receive");
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
          await (await h.request("feature-x.hello.example.test")).text(),
        ).toBe("preview body\n");
      } finally {
        await writeFile(hookPath, originalHook);
      }
      const started = Date.now();
      expect((await push(":feature-x")).code).toBe(0);
      const pushMs = Date.now() - started;
      await Promise.all([
        command([
          "git",
          "--git-dir",
          join(h.data, "repos/hello.git"),
          "rev-parse",
          "--verify",
          "refs/heads/feature-x",
        ]).then((result) => expect(result.code).not.toBe(0)),
        assertPreviewGone(h, app, "feature-x", "feature-x", images),
      ]);
      console.log(
        `Preview deletion: push completed in ${pushMs} ms; all resources verified gone in ${Date.now() - started} ms.`,
      );
      expect(Date.now() - started).toBeLessThan(10000);
      const xyImages = h.store
        .releases(app.id)
        .filter((r) => r.branch === "Feature/X-Y");
      await h.control("previews:destroy", "hello", "feature-x-y");
      await assertPreviewGone(h, app, "Feature/X-Y", "feature-x-y", xyImages);
      const mainDelete = await push(":main");
      expect(mainDelete.code).not.toBe(0);
      expect(mainDelete.output).toContain("main branch");
      // Changing the main branch also reclassifies existing release chains.
      await h.control("apps:set", "hello", "branch=master");
      expect((await push("HEAD:refs/heads/master")).code).toBe(0);
      expect(h.store.app("hello")?.main_branch).toBe("master");
      await eventually(async () => {
        expect(await (await h.request()).text()).toBe("preview body\n");
        expect(await (await h.request("main.hello.example.test")).text()).toBe(
          "hello from hoist\n",
        );
      });
      await h.control("apps:destroy", "hello", "--force");
      expect(await h.docker.listContainers({ "hoist.app": "hello" })).toEqual(
        [],
      );
      expect(await h.docker.listImages({ "hoist.app": "hello" })).toEqual([]);
      expect(
        await (
          await fetch(
            `http://127.0.0.1:${h.admin}/config/apps/http/servers/hoist/routes`,
          )
        ).json(),
      ).toEqual([]);
    });
  },
  180000,
);

scenario(
  "timer sweeps a two-day-old preview with a one-day TTL and keeps a fresh preview",
  async () => {
    await withSSH(async (h) => {
      await h.control("apps:create", "hello");
      expect((await h.push()).code).toBe(0);
      for (const branch of ["idle", "fresh"])
        await ok(["git", "push", "hoist", `HEAD:refs/heads/${branch}`], {
          cwd: h.source,
          env: h.pushEnv,
        });
      const app = h.store.app("hello");
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
      }, 10000);
      expect(h.store.releases(app.id).some((r) => r.branch === "idle")).toBe(
        false,
      );
      expect(
        await h.docker.listContainers({
          "hoist.app": "hello",
          "hoist.branch": "idle",
        }),
      ).toEqual([]);
      expect(
        await h.docker.listImages({
          "hoist.app": "hello",
          "hoist.release": String(old.id),
        }),
      ).toEqual([]);
      expect(
        await stat(join(h.data, "releases/hello/idle")).catch(() => null),
      ).toBeNull();
      expect(h.getLogs()).toContain("Swept preview hello idle");
      try {
        await eventually(async () => {
          expect((await h.request()).status).toBe(200);
          expect((await h.request("fresh.hello.example.test")).status).toBe(
            200,
          );
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
      expect(routes).not.toContain("idle.hello.example.test");
    });
  },
  90000,
);
