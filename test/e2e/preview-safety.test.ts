import { expect, test } from "bun:test";
import { join } from "node:path";
import { eventually } from "./harness";
import { command, withSSH } from "./ssh";

const scenario = process.env.HOIST_E2E !== undefined ? test : test.skip;
scenario(
  "unowned preview deletion preserves another app; multi-update pushes leave production unchanged; explicit destroy permits re-push",
  async () => {
    await withSSH(async (h) => {
      const { appName } = h;
      await h.control("apps:create", appName);
      expect((await h.push()).code).toBe(0);
      await h.control(
        "apps:create",
        `b-${appName}`,
        "--domain",
        `blocked.${appName}.example.test`,
      );
      const runGit = (...args: string[]) =>
        command(["git", ...args], { cwd: h.source, env: h.pushEnv });
      const app = h.store.app(appName);
      if (!app) throw new Error("missing app");
      // Use the already-configured remote's URL so this also exercises forced SSH dispatch.
      const helloRemote = (
        await runGit("remote", "get-url", "hoist")
      ).stdout.trim();
      const bPush = await runGit(
        "push",
        helloRemote.replace(`${appName}.git`, `b-${appName}.git`),
        "HEAD:refs/heads/main",
      );
      expect(bPush.code).toBe(0);
      const checkB = async () => {
        expect(
          await (await h.request(`blocked.${appName}.example.test`)).text(),
        ).toBe("hello from hoist\n");
      };
      await eventually(checkB);
      // Install a Git-only branch without ever reserving a Hoist preview.
      const sha = (await runGit("rev-parse", "HEAD")).stdout.trim();
      const repo = join(h.data, `repos/${appName}.git`);
      expect(
        (
          await command([
            "git",
            "--git-dir",
            repo,
            "update-ref",
            "refs/heads/blocked",
            sha,
          ])
        ).code,
      ).toBe(0);
      const refused = await command([
        ...h.ssh,
        h.remote,
        "hoist",
        "previews:destroy",
        appName,
        "blocked",
      ]);
      expect(refused.code).not.toBe(0);
      expect(refused.output).toContain(`no preview blocked for ${appName}`);
      await checkB();
      const deletion = await runGit("push", "hoist", ":blocked");
      expect(deletion.code).toBe(0);
      expect(deletion.output).toContain(
        "hoist: blocked had no preview; nothing to tear down",
      );
      await checkB();
      const rows = h.store.releases(app.id);
      const oldMain = (
        await command([
          "git",
          "--git-dir",
          repo,
          "rev-parse",
          "refs/heads/main",
        ])
      ).stdout;
      await Bun.write(
        join(h.source, "index.html"),
        "must not reach production\n",
      );
      await h.commit();
      const multiple = await runGit(
        "push",
        "hoist",
        "main",
        "HEAD:refs/heads/zbad",
      );
      expect(multiple.code).not.toBe(0);
      expect(multiple.output).toContain(
        "hoist deploys one branch per push; push main and zbad separately",
      );
      expect(h.store.releases(app.id)).toEqual(rows);
      expect(
        (
          await command([
            "git",
            "--git-dir",
            repo,
            "rev-parse",
            "refs/heads/main",
          ])
        ).stdout,
      ).toBe(oldMain);
      expect(await (await h.request()).text()).toBe("hello from hoist\n");

      expect(
        (await runGit("push", "hoist", "HEAD:refs/heads/feature")).code,
      ).toBe(0);
      const destroyed = await h.control("previews:destroy", appName, "feature");
      expect(destroyed.stdout).toContain(
        "deleted refs/heads/feature; push again to recreate it",
      );
      expect(
        (
          await command([
            "git",
            "--git-dir",
            repo,
            "rev-parse",
            "--verify",
            "refs/heads/feature",
          ])
        ).code,
      ).not.toBe(0);
      const recreated = await runGit(
        "push",
        "hoist",
        "HEAD:refs/heads/feature",
      );
      expect(recreated.code).toBe(0);
      expect(recreated.output).not.toContain("Everything up-to-date");
      await eventually(async () =>
        expect(
          await (await h.request(`feature.${appName}.example.test`)).text(),
        ).toBe("must not reach production\n"),
      );
      expect(h.store.previews(app.id).map((p) => p.branch)).toEqual([
        "feature",
      ]);
      for (const branch of ["old-one", "old-two"])
        expect(
          (
            await command([
              "git",
              "--git-dir",
              repo,
              "update-ref",
              `refs/heads/${branch}`,
              sha,
            ])
          ).code,
        ).toBe(0);
      await Bun.write(
        join(h.source, "revision.txt"),
        "one update with two deletions\n",
      );
      await h.commit();
      const mixed = await runGit(
        "push",
        "hoist",
        "HEAD:refs/heads/feature",
        ":old-one",
        ":old-two",
      );
      expect(mixed.code).toBe(0);
      expect(mixed.output).toContain(
        "old-one had no preview; nothing to tear down",
      );
      expect(mixed.output).toContain(
        "old-two had no preview; nothing to tear down",
      );
      await checkB();
    });
  },
  180000,
);
