import { expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eventually } from "./harness";
import { command, withSSH } from "./ssh";

const scenario = process.env.HOIST_E2E !== undefined ? test : test.skip;
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
scenario(
  "an older delayed deletion cannot tear down recreation before its Git ref commits",
  async () => {
    await withSSH(async (h) => {
      const { appName } = h;
      await h.control("apps:create", appName);
      const pushArgs = ["git", "push", "hoist", "HEAD:refs/heads/feature"];
      expect(
        (await command(pushArgs, { cwd: h.source, env: h.pushEnv })).code,
      ).toBe(0);
      const app = h.store.app(appName);
      if (!app) throw new Error("missing app");
      const repo = join(h.data, `repos/${appName}.git`);
      const prePath = join(repo, "hooks/pre-receive"),
        postPath = join(repo, "hooks/post-receive");
      const pre = await readFile(prePath, "utf8"),
        post = await readFile(postPath, "utf8");
      const built = join(h.root, "recreated-built"),
        release = join(h.root, "release-ref");
      const spawnPush = (args: string[]) => {
        const child = Bun.spawn(args, {
          cwd: h.source,
          env: h.pushEnv,
          stdout: "pipe",
          stderr: "pipe",
        });
        const logs = { stderr: "" };
        const stderr = (async () => {
          for await (const chunk of child.stderr)
            logs.stderr += new TextDecoder().decode(chunk);
        })();
        const done = Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          stderr,
        ]).then(([code, stdout]) => ({ code, output: stdout + logs.stderr }));
        return { child, logs, done };
      };
      let deletion: ReturnType<typeof spawnPush> | undefined;
      let recreation: ReturnType<typeof spawnPush> | undefined;
      try {
        await writeFile(
          postPath,
          post.replace(
            "\nexec ",
            "\nHOIST_E2E=1 HOIST_TEST_HOOK_DELAY_MS=30000 exec ",
          ),
        );
        deletion = spawnPush(["git", "push", "hoist", ":feature"]);
        const deleting = deletion;
        await eventually(
          async () =>
            expect(deleting.logs.stderr).toContain(
              "hoist: delaying post-receive for race test",
            ),
          10000,
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
        // The real pre-receive finishes, releases its app lease, then waits before Git commits.
        await writeFile(
          prePath,
          `${pre.replace("\nexec ", "\n")}\n[ "$?" -eq 0 ] || exit 1\ntouch ${quote(built)}\nwhile [ ! -f ${quote(release)} ]; do sleep 0.05; done\n`,
        );
        recreation = spawnPush(pushArgs);
        await eventually(
          async () =>
            expect(await stat(built).catch(() => null)).not.toBeNull(),
          25000,
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
        const result = await deletion.done;
        expect(result.code).toBe(0);
        expect(result.output).toContain(
          "branch feature was recreated after this deletion; keeping it",
        );
        expect(
          h.store.releases(app.id).filter((r) => r.status === "live"),
        ).toHaveLength(1);
        await writeFile(postPath, post);
        await writeFile(release, "");
        expect((await recreation.done).code).toBe(0);
        await eventually(async () =>
          expect(
            await (await h.request(`feature.${appName}.example.test`)).text(),
          ).toBe("hello from hoist\n"),
        );
      } finally {
        await writeFile(release, "");
        await writeFile(prePath, pre);
        await writeFile(postPath, post);
        await Promise.all([deletion?.done, recreation?.done]);
      }
    });
  },
  120000,
);
