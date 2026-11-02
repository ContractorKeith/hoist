import { expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eventually } from "./harness";
import { command, withSSH } from "./ssh";

async function releaseTags(): Promise<string[]> {
  // The adapter intentionally lists intermediate build images for teardown. Retention owns tags.
  const filters = encodeURIComponent(
    JSON.stringify({ reference: ["hoist/hello:*"] }),
  );
  const response = await fetch(
    `http://localhost/v1.47/images/json?filters=${filters}`,
    {
      unix: (process.env.DOCKER_HOST ?? "/var/run/docker.sock").replace(
        /^unix:\/\//,
        "",
      ),
    },
  );
  if (!response.ok) throw new Error(`Image listing failed: ${response.status}`);
  const rows = (await response.json()) as { RepoTags?: string[] }[];
  return rows
    .flatMap((row) => row.RepoTags ?? [])
    .filter((tag) => tag.startsWith("hoist/hello:"));
}

const scenario = process.env.HOIST_E2E !== undefined ? test : test.skip;
scenario(
  "config reaches the app; rollback restores image and config; restart uses current config",
  async () => {
    await withSSH(async (h) => {
      await h.control("apps:create", "hello");
      await h.control(
        "config:set",
        "hello",
        "HOIST_TEST_A=unique-secret-one",
        "HOIST_TEST_B=2",
      );
      expect((await h.push()).code).toBe(0);
      const app = h.store.app("hello");
      if (!app) throw new Error("missing app");
      const rows = () => h.store.releases(app.id);
      const first = rows()[0];
      if (!first) throw new Error("missing v1");
      await eventually(async () => {
        expect(await (await h.request(undefined, "/env")).text()).toBe(
          "HOIST_TEST_A=unique-secret-one\nHOIST_TEST_B=2\n",
        );
      });
      const masked = await h.control("config:list", "hello");
      expect(masked.stdout).toContain("HOIST_TEST_A=•••• (17 bytes)");
      expect(masked.stdout).not.toContain("unique-secret-one");
      expect(
        (await h.control("config:list", "hello", "--reveal")).stdout,
      ).toContain("HOIST_TEST_A=unique-secret-one");
      await h.control("config:set", "hello", "HOIST_TEST_A=2");
      await writeFile(join(h.source, "index.html"), "second image\n");
      await h.commit();
      expect((await h.push()).code).toBe(0);
      const second = rows()[1];
      if (!second) throw new Error("missing v2");
      await h.control("rollback", "hello", "v1");
      expect(await (await h.request()).text()).toBe("hello from hoist\n");
      expect(await (await h.request(undefined, "/env")).text()).toContain(
        "HOIST_TEST_A=unique-secret-one",
      );
      expect(rows()[2]?.image).toBe(first.image);
      expect(rows()[2]?.config_json).toBe(first.config_json);
      const listed = JSON.parse(
        (await h.control("releases", "hello", "--json")).stdout,
      );
      expect(listed[2].live).toBe(true);
      expect(listed[2].number).toBe(3);
      expect(listed[2].image).toBe(first.image);
      await h.control("rollback", "hello");
      expect(rows()[3]?.image).toBe(second.image);
      expect(await (await h.request(undefined, "/env")).text()).toContain(
        "HOIST_TEST_A=2\n",
      );
      const refused = await command([
        ...h.ssh,
        h.remote,
        "hoist",
        "rollback",
        "hello",
        "v99",
      ]);
      expect(refused.code).toBe(1);
      expect(refused.output).toContain("Unknown rollback target v99");
      await h.control("config:set", "hello", "HOIST_TEST_A=restart-value");
      await h.control("restart", "hello");
      expect(rows()[4]?.image).toBe(second.image);
      expect(await (await h.request(undefined, "/env")).text()).toContain(
        "HOIST_TEST_A=restart-value\n",
      );
      await h.stopServe();
      const live = rows().at(-1);
      if (!live?.container_id) throw new Error("missing live container");
      await h.docker.stopContainer(live.container_id);
      await h.startServe();
      expect(await (await h.request(undefined, "/env")).text()).toContain(
        "HOIST_TEST_A=restart-value\n",
      );
      for (const name of ["hoist.db", "hoist.db-wal"])
        expect(
          (await readFile(join(h.data, name))).includes(
            Buffer.from("unique-secret-one"),
          ),
        ).toBe(false);
      for (const row of rows()) {
        const log = await readFile(
          join(h.data, "releases/hello/main", `v${row.number}`, "build.log"),
          "utf8",
        );
        expect(log).not.toContain("unique-secret-one");
        expect(log).not.toContain("restart-value");
        if (row.number >= 3) {
          expect(log).toContain("Live:");
          expect(log).not.toContain("Step 1");
        }
      }
      await h.control("config:unset", "hello", "HOIST_TEST_B");
      expect(
        (await h.control("config:list", "hello", "--json")).stdout,
      ).not.toContain("HOIST_TEST_B");
    });
  },
  180000,
);

scenario(
  "sixth push prunes; retention one leaves only live image and logs",
  async () => {
    await withSSH(async (h) => {
      await h.control("apps:create", "hello");
      const app = h.store.app("hello");
      if (!app) throw new Error("missing app");
      for (let i = 1; i <= 6; i++) {
        await writeFile(join(h.source, "index.html"), `release ${i}\n`);
        await h.commit();
        expect((await h.push()).code).toBe(0);
      }
      expect(await releaseTags()).toHaveLength(5);
      expect(await readdir(join(h.data, "releases/hello/main"))).toHaveLength(
        5,
      );
      expect(h.store.releases(app.id)[0]?.pruned_at).toBeTruthy();
      await h.control("apps:set", "hello", "retention=1");
      await writeFile(join(h.source, "index.html"), "release 7\n");
      await h.commit();
      expect((await h.push()).code).toBe(0);
      const live = h.store.releases(app.id).at(-1);
      if (!live) throw new Error("missing live release");
      expect(await releaseTags()).toEqual([live.image]);
      expect(await readdir(join(h.data, "releases/hello/main"))).toEqual([
        "v7",
      ]);
      expect(h.store.releases(app.id).at(-1)?.pruned_at).toBeNull();
      expect(await (await h.request()).text()).toBe("release 7\n");
    });
  },
  240000,
);
