import { expect, test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eventually } from "./harness";
import { command, withSSH } from "./ssh";

const scenario = process.env.HOIST_E2E !== undefined ? test : test.skip;
scenario(
  "previews inherit encrypted config and retention; custom main drives rollback, restart and logs",
  async () => {
    await withSSH(async (h) => {
      await h.control("apps:create", "hello");
      await h.control("apps:set", "hello", "branch=stable");
      await h.control("apps:set", "hello", "retention=2");
      await h.control("config:set", "hello", "HOIST_TEST_LABEL=main-first");
      const push = (branch: string) =>
        command(["git", "push", "hoist", `HEAD:refs/heads/${branch}`], {
          cwd: h.source,
          env: h.pushEnv,
        });
      expect((await push("stable")).code).toBe(0);
      const app = h.store.app("hello");
      if (!app) throw new Error("missing app");
      expect(app.main_branch).toBe("stable");
      expect(app.retention).toBe(2);
      await h.control(
        "config:set",
        "hello",
        "HOIST_TEST_LABEL=preview-snapshot",
      );
      expect((await push("Feature/X-Y")).code).toBe(0);
      const preview = h.store
        .releases(app.id)
        .find((r) => r.branch === "Feature/X-Y");
      if (!preview) throw new Error("missing preview");
      expect(preview.config_json).not.toContain("preview-snapshot");
      await eventually(async () => {
        expect(
          await (
            await h.request("feature-x-y.hello.example.test", "/env")
          ).text(),
        ).toBe("HOIST_TEST_LABEL=preview-snapshot\n");
        expect(await (await h.request(undefined, "/env")).text()).toBe(
          "HOIST_TEST_LABEL=main-first\n",
        );
      });
      const filtered = JSON.parse(
        (
          await h.control(
            "releases",
            "hello",
            "--branch",
            "feature-x-y",
            "--json",
          )
        ).stdout,
      );
      expect(filtered).toHaveLength(1);
      expect(filtered[0].branch).toBe("Feature/X-Y");
      const previewLog = await h.control(
        "logs",
        "hello",
        "--branch",
        "feature-x-y",
        "--release",
        "v1",
      );
      expect(previewLog.stdout).toContain(
        "Live: https://feature-x-y.hello.example.test",
      );
      expect(previewLog.stdout).not.toContain('{"stream":');

      await h.control("config:set", "hello", "HOIST_TEST_LABEL=main-second");
      await writeFile(join(h.source, "index.html"), "second main image\n");
      await h.commit();
      expect((await push("stable")).code).toBe(0);
      await h.control("rollback", "hello", "v1");
      await eventually(async () => {
        expect(await (await h.request()).text()).toBe("hello from hoist\n");
        expect(await (await h.request(undefined, "/env")).text()).toBe(
          "HOIST_TEST_LABEL=main-first\n",
        );
      });
      await h.control(
        "config:set",
        "hello",
        "HOIST_TEST_LABEL=restart-current",
      );
      await h.control("restart", "hello");
      await eventually(async () => {
        expect(await (await h.request(undefined, "/env")).text()).toBe(
          "HOIST_TEST_LABEL=restart-current\n",
        );
        expect(
          await (
            await h.request("feature-x-y.hello.example.test", "/env")
          ).text(),
        ).toBe("HOIST_TEST_LABEL=preview-snapshot\n");
      });
      const mainRows = h.store
        .releases(app.id)
        .filter((r) => r.branch === "stable");
      expect(
        mainRows.filter((r) => r.status === "live").map((r) => r.number),
      ).toEqual([4]);
      const mainBefore = JSON.stringify(mainRows);
      expect(
        (await h.control("logs", "hello", "--release", "v4")).stdout,
      ).toContain("Live: https://hello.example.test");
      expect((await h.control("logs", "hello")).stdout).toContain(
        "httpd listening on 8080",
      );
      expect(
        await stat(join(h.data, "releases/hello/stable/v4/build.log")),
      ).toBeDefined();

      // The third preview push prunes only its own v1, preserving stable's chain.
      for (let index = 0; index < 2; index++) {
        await writeFile(join(h.source, "revision.txt"), `${index}\n`);
        await h.commit();
        expect((await push("Feature/X-Y")).code).toBe(0);
      }
      const previews = h.store
        .releases(app.id)
        .filter((r) => r.branch === "Feature/X-Y");
      expect(previews.find((r) => r.number === 1)?.pruned_at).toBeTruthy();
      expect(previews.filter((r) => !r.pruned_at).map((r) => r.number)).toEqual(
        [2, 3],
      );
      expect(
        await stat(join(h.data, "releases/hello/feature-x-y/v1")).catch(
          () => null,
        ),
      ).toBeNull();
      await expect(h.docker.imagePorts(preview.image)).rejects.toThrow("404");
      expect(
        JSON.stringify(
          h.store.releases(app.id).filter((r) => r.branch === "stable"),
        ),
      ).toBe(mainBefore);
      await eventually(async () => {
        expect(
          await (
            await h.request("feature-x-y.hello.example.test", "/env")
          ).text(),
        ).toBe("HOIST_TEST_LABEL=restart-current\n");
      });
      await h.control("previews:destroy", "hello", "feature-x-y");
      expect(
        h.store.releases(app.id).some((r) => r.branch === "Feature/X-Y"),
      ).toBe(false);
      expect(
        await stat(join(h.data, "releases/hello/feature-x-y")).catch(
          () => null,
        ),
      ).toBeNull();
      expect((await h.request()).status).toBe(200);
    });
  },
  240000,
);
