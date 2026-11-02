import { expect, test } from "bun:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eventually } from "./harness";
import { ok, withSSH } from "./ssh";

const scenario = process.env.HOIST_E2E !== undefined ? test : test.skip;
scenario(
  "unwritable old logs warn without rejecting a completed push, restart or rollback",
  async () => {
    await withSSH(async (h) => {
      const { appName } = h;
      await h.control("apps:create", appName);
      await h.control("apps:set", appName, "retention=1");
      expect((await h.push()).code).toBe(0);
      const app = h.store.app(appName);
      if (!app) throw new Error("missing app");
      const blocked = join(h.data, `releases/${appName}/main/v1`);
      await chmod(blocked, 0o500);
      try {
        await writeFile(join(h.source, "index.html"), "v2 accepted\n");
        const sha = await h.commit();
        const pushed = await h.push();
        expect(pushed.code).toBe(0);
        expect(pushed.output).toContain("prune: could not remove ");
        expect(pushed.output).toContain("EACCES");
        const rows = () => h.store.releases(app.id);
        expect(rows()[1]?.status).toBe("live");
        expect(rows()[1]?.git_sha).toBe(sha);
        expect(
          (
            await ok([
              "git",
              "--git-dir",
              join(h.data, `repos/${appName}.git`),
              "rev-parse",
              "main",
            ])
          ).stdout.trim(),
        ).toBe(sha);
        await eventually(async () => {
          expect(await (await h.request()).text()).toBe("v2 accepted\n");
        });
        expect(
          await readFile(
            join(h.data, `releases/${appName}/main/v2/build.log`),
            "utf8",
          ),
        ).toContain("prune: could not remove ");
        const restarted = await h.control("restart", appName);
        expect(restarted.output).toContain("prune: could not remove ");
        expect(rows()[2]?.status).toBe("live");
        expect(
          await readFile(
            join(h.data, `releases/${appName}/main/v3/build.log`),
            "utf8",
          ),
        ).toContain("prune: could not remove ");
        const rolled = await h.control("rollback", appName, "v2");
        expect(rolled.output).toContain("prune: could not remove ");
        expect(rows()[3]?.status).toBe("live");
        expect(
          await readFile(
            join(h.data, `releases/${appName}/main/v4/build.log`),
            "utf8",
          ),
        ).toContain("prune: could not remove ");
        expect(await (await h.request()).text()).toBe("v2 accepted\n");
      } finally {
        await chmod(blocked, 0o700);
      }
    });
  },
  180000,
);
