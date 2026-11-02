import { expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Docker } from "../../src/adapters/docker";
import { eventually } from "./harness";
import { command, ok, withSSH } from "./ssh";

const scenario = process.env.HOIST_E2E !== undefined ? test : test.skip;

scenario(
  "push over forced-command SSH makes v1 live, rejects missing Dockerfile and destroys the app",
  async () => {
    await withSSH(
      async ({
        appName,
        control,
        source,
        data,
        store,
        docker,
        push,
        commit,
        ssh,
        remote,
        pushEnv,
        request,
      }) => {
        expect((await control("apps:create", appName)).output).toContain(
          `Created ${appName}`,
        );
        expect(
          JSON.parse((await control("apps:list", "--json")).stdout),
        ).toHaveLength(1);
        expect(
          (await command([...ssh, remote, `apps:create ${appName}`])).code,
        ).toBe(1);
        const result = await push();
        expect(result.code).toBe(0);
        expect(result.output).toContain(
          `Live: https://${appName}.example.test`,
        );
        const app = store.app(appName);
        if (!app) throw new Error("Missing app");
        const release = store.releases(app.id)[0];
        if (!release) throw new Error("Missing release");
        expect(release).toMatchObject({
          number: 1,
          status: "live",
          config_json: "{}",
        });
        expect(release.git_sha).toBe(
          (
            await ok(["git", "rev-parse", "HEAD"], { cwd: source })
          ).stdout.trim(),
        );
        const info = JSON.parse(
          (await control("apps:info", appName, "--json")).stdout,
        );
        expect(info.health_path).toBe("/");
        expect(info.releases).toHaveLength(1);
        expect(info.releases[0]).toMatchObject({ number: 1, status: "live" });
        expect(release.image).toBe(
          `hoist/${appName}:main-v1-${release.git_sha.slice(0, 12)}`,
        );
        await eventually(async () => {
          const response = await request();
          expect(response.status).toBe(200);
          expect(await response.text()).toBe("hello from hoist\n");
        });
        const log = await readFile(
          join(data, `releases/${appName}/main/v1/build.log`),
          "utf8",
        );
        expect(log).not.toContain('"stream"');
        expect(log).toContain("Step 1/");
        expect(log).toContain("Swapping Caddy upstream");
        const remoteLog = result.stderr
          .replace(/\r/g, "")
          .split("\n")
          .filter((line) => line.startsWith("remote: "))
          .map((line) =>
            line
              .slice(8)
              .replace(/[ \t]+remote:\s*$/, "")
              .trimEnd(),
          )
          .join("\n");
        expect(remoteLog).toBe(log.replace(/\r/g, "").trimEnd());
        expect(
          await docker.listImages({
            "hoist.app": appName,
            "hoist.sha": release.git_sha,
            "hoist.release": String(release.id),
          }),
        ).toHaveLength(1);
        expect((await stat(join(data, "hoist.db"))).mode & 0o777).toBe(0o600);
        expect(
          (await stat(join(data, `repos/${appName}.git`))).mode & 0o777,
        ).toBe(0o700);
        const tree = (
          await ok(["git", "rev-parse", "HEAD^{tree}"], { cwd: source })
        ).stdout.trim();
        const treePush = await command(
          ["git", "push", "hoist", `${tree}:refs/heads/treepush`],
          { cwd: source, env: pushEnv },
        );
        expect(treePush.code).not.toBe(0);
        expect(treePush.output).toContain("pushed object is not a commit");
        expect(store.releases(app.id)).toHaveLength(1);
        await ok(["git", "rm", "Dockerfile"], { cwd: source });
        await commit();
        const rejected = await push();
        expect(rejected.code).not.toBe(0);
        expect(rejected.output.match(/Missing root Dockerfile/g)).toHaveLength(
          1,
        );
        const failed = store.releases(app.id)[1];
        expect(failed?.status).toBe("failed");
        expect(
          await readFile(
            join(data, `releases/${appName}/main/v2/build.log`),
            "utf8",
          ),
        ).toContain("Missing root Dockerfile");
        expect(
          await docker.listImages({
            "hoist.app": appName,
            "hoist.release": String(failed?.id),
          }),
        ).toEqual([]);
        const unknown = await command(
          ["git", "push", `ssh://${remote}/unknown.git`, "main"],
          { cwd: source, env: pushEnv },
        );
        expect(unknown.code).not.toBe(0);
        expect(unknown.output).toContain("hoist apps:create unknown");
        expect(
          (await command([...ssh, remote, `apps:destroy ${appName}`])).output,
        ).toContain("requires --force");
        await control("apps:destroy", appName, "--force");
        expect(
          JSON.parse((await control("apps:list", "--json")).stdout),
        ).toEqual([]);
        for (const path of [`repos/${appName}.git`, `releases/${appName}`])
          expect(await stat(join(data, path)).catch(() => null)).toBeNull();
        expect(store.apps()).toEqual([]);
        expect(store.releases(app.id)).toEqual([]);
        expect(await docker.listContainers({ "hoist.app": appName })).toEqual(
          [],
        );
        expect(await docker.listImages({ "hoist.app": appName })).toEqual([]);
        expect(await readdir(join(data, "tmp"))).toEqual([]);
      },
    );
  },
  180000,
);

scenario(
  "cancelled or aborted build streams return fds to baseline",
  async () => {
    if (process.platform !== "linux") throw new Error("E2e requires Linux");
    const docker = new Docker();
    await docker.ping();
    const root = await mkdtemp(join(tmpdir(), "hoist-cancel-"));
    const labels = { "hoist.test": crypto.randomUUID() };
    const tag = `hoist/cancel:${labels["hoist.test"]}`;
    try {
      await writeFile(
        join(root, "Dockerfile"),
        "FROM alpine:3.21\nRUN sleep 5\n",
      );
      const build = () =>
        docker.buildImage(
          { contextDir: root, tag, labels },
          AbortSignal.timeout(30000),
        );
      // Warm Bun's HTTP machinery before measuring persistent connections.
      await (await build()).cancel();
      await Bun.sleep(200);
      const baseline = (await readdir("/proc/self/fd")).length;
      for (let i = 0; i < 5; i++) await (await build()).cancel();
      await eventually(async () => {
        expect((await readdir("/proc/self/fd")).length).toBe(baseline);
      });
      for (let i = 0; i < 5; i++) {
        const controller = new AbortController();
        await docker.buildImage(
          { contextDir: root, tag, labels },
          controller.signal,
        );
        controller.abort();
      }
      await eventually(async () => {
        expect((await readdir("/proc/self/fd")).length).toBe(baseline);
      });
      console.log(
        `Docker cancellation: five early cancellations and five abandoned streams aborted; fd baseline ${baseline} restored.`,
      );
    } finally {
      for (const image of await docker.listImages(labels))
        await docker.removeImage(image);
      await rm(root, { recursive: true, force: true });
      expect(await docker.listImages(labels)).toEqual([]);
    }
  },
  180000,
);
