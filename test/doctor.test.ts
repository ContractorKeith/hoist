import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDocker } from "../src/adapters/fakes/docker";
import { doctorChecks, runChecks } from "../src/cli/doctor";
import { createRepo, executableCommand } from "../src/git/repository";
import { DashboardStore } from "../src/store/dashboard";
import { SqliteStore } from "../src/store/sqlite";

describe("doctor", () => {
  test("every check reports success or a single-line fix and continues after failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctor-"));
    const store = new SqliteStore(root);
    try {
      const checks = doctorChecks(root, store, new FakeDocker());
      for (const name of Object.keys(checks)) {
        expect(await runChecks({ [name]: () => {} })).toEqual([
          { check: name, status: "ok", message: `${name} is ready.` },
        ]);
        const rows = await runChecks({
          [name]: () => {
            throw new Error("Repair\nthis dependency.");
          },
          next: () => {},
        });
        expect(rows.map((r) => r.status)).toEqual(["error", "ok"]);
        expect(rows[0]?.message).toBe("Repair this dependency.");
      }
      const rows = await runChecks(
        {
          "Serve lease": () => {
            throw Error("Start serve.");
          },
          "Dashboard password": () => {
            throw Error("Set password.");
          },
        },
        true,
      );
      expect(rows.map((r) => r.status)).toEqual(["warning", "error"]);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  test("real probes use fake Docker and admin responses, repair both hooks and find orphans", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctor-"));
    const store = new SqliteStore(root);
    const docker = new FakeDocker();
    let routes: unknown[] = [],
      images: unknown[] = [];
    const request = (async (input: string | URL | Request) =>
      Response.json(
        String(input).includes("images/json") ? images : routes,
      )) as typeof fetch;
    try {
      const app = store.createApp("doctor-test", "doctor.test", "/");
      await createRepo(root, app.name);
      for (const name of ["pre-receive", "post-receive"])
        await Bun.write(
          join(root, "repos/doctor-test.git/hooks", name),
          "#!/bin/sh\nexec /missing/hoist\n",
        );
      const checks = doctorChecks(root, store, docker, request);
      const hooks = await checks.Hooks?.();
      expect(String(hooks)).toContain("/missing/hoist");
      for (const name of ["pre-receive", "post-receive"])
        expect(
          await readFile(
            join(root, "repos/doctor-test.git/hooks", name),
            "utf8",
          ),
        ).toContain(executableCommand());
      expect(await checks.Hooks?.()).toBe("");
      for (const name of [
        "Docker",
        "Git",
        "Tar",
        "Data directory",
        "Database",
        "Secret key",
        "Caddy admin",
        "TLS and ports",
        "Orphan containers",
        "Orphan images",
        "Orphan routes",
      ])
        expect(
          (await runChecks({ [name]: checks[name] as () => unknown }))[0]
            ?.status,
        ).toBe("ok");
      expect(
        (
          await runChecks({
            password: checks["Dashboard password"] as () => unknown,
          })
        )[0]?.status,
      ).toBe("error");
      new DashboardStore(store.db).savePassword("hash");
      expect(
        (
          await runChecks({
            password: checks["Dashboard password"] as () => unknown,
          })
        )[0]?.status,
      ).toBe("ok");
      expect(
        (await runChecks({ lease: checks["Serve lease"] as () => unknown }))[0]
          ?.status,
      ).toBe("error");
      store.acquireLock(
        "serve",
        process.pid,
        new Date().toISOString(),
        () => true,
      );
      expect(
        (await runChecks({ lease: checks["Serve lease"] as () => unknown }))[0]
          ?.status,
      ).toBe("ok");
      await chmod(root, 0o755);
      expect(
        (await runChecks({ dir: checks["Data directory"] as () => unknown }))[0]
          ?.status,
      ).toBe("error");
      await chmod(root, 0o700);
      await unlink(join(root, "secret.key"));
      store.setConfig(app.id, "KEY", "ciphertext");
      expect(
        (await runChecks({ key: checks["Secret key"] as () => unknown }))[0]
          ?.status,
      ).toBe("error");
      images = [
        {
          Id: "sha256:orphan",
          RepoTags: ["hoist/unknown:main-v1"],
          Labels: {},
        },
      ];
      routes = [{ match: [{ host: ["orphan.test"] }] }];
      expect(
        (
          await runChecks({
            images: checks["Orphan images"] as () => unknown,
            routes: checks["Orphan routes"] as () => unknown,
          })
        ).every((r) => r.status === "error"),
      ).toBe(true);
      const broken = doctorChecks(
        root,
        store,
        {
          ...docker,
          ping: async () => {
            throw Error("Docker unavailable.");
          },
        } as unknown as FakeDocker,
        request,
      );
      expect(
        (await runChecks({ docker: broken.Docker as () => unknown }))[0]
          ?.status,
      ).toBe("error");
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
