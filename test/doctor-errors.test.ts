import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDocker } from "../src/adapters/fakes/docker";
import { doctorChecks, runChecks } from "../src/cli/doctor";
import { SqliteStore } from "../src/store/sqlite";

describe("doctor failures", () => {
  test("dependency, TLS, port, lease, image and route checks fail on broken fakes", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctor-errors-"));
    const store = new SqliteStore(root);
    const docker = new FakeDocker();
    const request = (async () => Response.json([])) as unknown as typeof fetch;
    const checks = doctorChecks(root, store, docker, request);
    const check = async (name: string) =>
      (await runChecks({ [name]: checks[name] as () => unknown }))[0]?.status;
    const previousTLS = process.env.HOIST_TLS,
      previousPort = process.env.HOIST_DASHBOARD_PORT;
    try {
      const which = spyOn(Bun, "which").mockReturnValue(null);
      try {
        expect(await check("Git")).toBe("error");
        expect(await check("Tar")).toBe("error");
      } finally {
        which.mockRestore();
      }
      const file = spyOn(Bun, "file").mockImplementation(
        () =>
          ({
            arrayBuffer: async () => new ArrayBuffer(0),
          }) as unknown as ReturnType<typeof Bun.file>,
      );
      try {
        expect(await check("Caddy binary")).toBe("error");
      } finally {
        file.mockRestore();
      }
      process.env.HOIST_TLS = "invalid";
      expect(await check("TLS and ports")).toBe("error");
      process.env.HOIST_TLS = "internal";
      process.env.HOIST_DASHBOARD_PORT = process.env.HOIST_HTTP_PORT ?? "80";
      expect(await check("TLS and ports")).toBe("error");
      store.acquireLock(
        "serve",
        2147483647,
        new Date().toISOString(),
        () => false,
      );
      expect(await check("Serve lease")).toBe("error");
      docker.containers.set("orphan", {
        id: "orphan",
        image: "hoist/missing:main-v1",
        labels: { "hoist.app": "missing", "hoist.release": "123" },
      });
      expect(await check("Orphan containers")).toBe("error");
      const unavailable = doctorChecks(root, store, docker, (async () => {
        throw Error("offline");
      }) as unknown as typeof fetch);
      expect(
        (
          await runChecks(
            { "Orphan routes": unavailable["Orphan routes"] as () => unknown },
            true,
          )
        )[0]?.status,
      ).toBe("warning");
      const hostless = doctorChecks(root, store, docker, (async () =>
        Response.json([{ "@id": "orphan" }])) as unknown as typeof fetch);
      expect(
        (
          await runChecks(
            { "Orphan routes": hostless["Orphan routes"] as () => unknown },
            true,
          )
        )[0]?.status,
      ).toBe("error");
    } finally {
      if (previousTLS === undefined) delete process.env.HOIST_TLS;
      else process.env.HOIST_TLS = previousTLS;
      if (previousPort === undefined) delete process.env.HOIST_DASHBOARD_PORT;
      else process.env.HOIST_DASHBOARD_PORT = previousPort;
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
