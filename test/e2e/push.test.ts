import { expect, test } from "bun:test";
import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { Docker } from "../../src/adapters/docker";
import { SqliteStore } from "../../src/store/sqlite";
import { eventually, highPort } from "./harness";

const scenario = process.env.HOIST_E2E !== undefined ? test : test.skip;
const cli = resolve(import.meta.dir, "../../src/cli/index.ts");

async function command(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const child = Bun.spawn(args, { ...options, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code, output: stdout + stderr };
}
async function ok(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = await command(args, options);
  if (result.code) throw new Error(`${args[0]} failed: ${result.output}`);
  return result;
}
async function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

scenario(
  "push over forced-command SSH builds v1, rejects missing Dockerfile and destroys the app",
  async () => {
    if (process.platform !== "linux") throw new Error("E2e requires Linux");
    const docker = new Docker();
    await docker.ping();
    const root = await mkdtemp(join(tmpdir(), "hoist-ssh-"));
    const data = join(root, "data"),
      source = join(root, "source");
    const port = await highPort();
    const env = {
      ...process.env,
      HOIST_DIR: data,
      HOIST_DOMAIN: "example.test",
    };
    let sshd: ReturnType<typeof Bun.spawn> | undefined;
    let sshdLogs: Promise<string> | undefined;
    let store: SqliteStore | undefined;
    const failures: unknown[] = [];
    try {
      await ok([
        "ssh-keygen",
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        join(root, "host"),
      ]);
      await ok([
        "ssh-keygen",
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        join(root, "client"),
      ]);
      const forced = `${process.execPath} ${cli} ssh-dispatch`;
      await writeFile(
        join(root, "authorized_keys"),
        `command="${forced}",environment="HOIST_DIR=${data}",environment="HOIST_DOMAIN=example.test",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ${await readFile(join(root, "client.pub"), "utf8")}`,
      );
      const config = join(root, "sshd_config");
      await writeFile(
        config,
        `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${root}/host\nAuthorizedKeysFile ${root}/authorized_keys\nPidFile none\nUsePAM no\nStrictModes no\nPermitUserEnvironment yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nLogLevel VERBOSE\n`,
      );
      const daemon = Bun.spawn(["/usr/sbin/sshd", "-D", "-e", "-f", config], {
        stdout: "ignore",
        stderr: "pipe",
      });
      sshd = daemon;
      sshdLogs = new Response(daemon.stderr).text();
      await eventually(async () => {
        if (daemon.exitCode !== null)
          throw new Error(`sshd exited: ${await sshdLogs}`);
        expect(await listening(port)).toBe(true);
      });
      const ssh = [
        "ssh",
        "-i",
        join(root, "client"),
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "BatchMode=yes",
        "-p",
        String(port),
      ];
      const remote = `${userInfo().username}@127.0.0.1`;
      const control = (...args: string[]) =>
        ok([...ssh, remote, "hoist", ...args]);
      // README walkthrough: create, add remote, push. Control verbs use the same forced command.
      const created = await control("apps:create", "hello");
      expect(created.output).toContain("Created hello");
      expect((await command([...ssh, remote, "apps:create hello"])).code).toBe(
        1,
      );
      expect(
        JSON.parse((await control("apps:list", "--json")).stdout),
      ).toHaveLength(1);
      expect(
        JSON.parse((await control("apps:info", "hello", "--json")).stdout)
          .health_path,
      ).toBe("/");
      await cp(resolve(import.meta.dir, "../fixtures/hello"), source, {
        recursive: true,
      });
      await ok(["git", "init", "--initial-branch=main"], { cwd: source });
      await ok(["git", "add", "."], { cwd: source });
      const commit = () =>
        ok(
          [
            "git",
            "-c",
            "user.name=ContractorKeith",
            "-c",
            "user.email=ContractorKeith@users.noreply.github.com",
            "commit",
            "-m",
            "fixture",
          ],
          { cwd: source },
        );
      await commit();
      const sha = (
        await ok(["git", "rev-parse", "HEAD"], { cwd: source })
      ).stdout.trim();
      await ok(
        ["git", "remote", "add", "hoist", `ssh://${remote}:${port}/hello.git`],
        { cwd: source },
      );
      // Paths are test-owned; GIT_SSH_COMMAND is git's client-side transport configuration.
      const pushEnv = {
        ...env,
        GIT_SSH_COMMAND: ssh
          .map((arg) => `'${arg.replace(/'/g, "'\\''")}'`)
          .join(" "),
      };
      const push = await ok(["git", "push", "hoist", "main"], {
        cwd: source,
        env: pushEnv,
      });
      store = new SqliteStore(data);
      const app = store.app("hello");
      if (!app) throw new Error("Missing app");
      const release = store.releases(app.id)[0];
      if (!release) throw new Error("Missing release");
      expect(release.number).toBe(1);
      expect(release.git_sha).toBe(sha);
      expect(release.image).toBe(`hoist/hello:main-v1-${sha.slice(0, 12)}`);
      expect(release.status).toBe("built");
      const info = JSON.parse(
        (await control("apps:info", "hello", "--json")).stdout,
      );
      expect(info.releases).toHaveLength(1);
      expect(info.releases[0]).toMatchObject({ number: 1, status: "built" });
      expect(release.config_json).toBe("{}");
      const log = await readFile(
        join(data, "releases/hello/main/v1/build.log"),
        "utf8",
      );
      expect(log).toContain('"stream"');
      const remoteLog = push.stderr
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
          "hoist.app": "hello",
          "hoist.sha": sha,
          "hoist.release": String(release.id),
        }),
      ).toHaveLength(1);
      expect((await stat(join(data, "hoist.db"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(data, "repos/hello.git"))).mode & 0o777).toBe(
        0o700,
      );
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
      expect(
        await docker.listImages({ "hoist.app": "hello", "hoist.sha": tree }),
      ).toEqual([]);
      await ok(["git", "rm", "Dockerfile"], { cwd: source });
      await commit();
      const rejected = await command(["git", "push", "hoist", "main"], {
        cwd: source,
        env: pushEnv,
      });
      expect(rejected.code).not.toBe(0);
      expect(rejected.output).toContain("add a Dockerfile");
      expect(rejected.output.match(/Missing root Dockerfile/g)).toHaveLength(1);
      const failed = store.releases(app.id)[1];
      if (!failed) throw new Error("Missing failed release");
      expect(failed.status).toBe("failed");
      expect(
        await readFile(join(data, "releases/hello/main/v2/build.log"), "utf8"),
      ).toContain("Missing root Dockerfile");
      expect(
        await docker.listImages({
          "hoist.app": "hello",
          "hoist.release": String(failed.id),
        }),
      ).toEqual([]);
      const unknown = await command(
        ["git", "push", `ssh://${remote}:${port}/unknown.git`, "main"],
        { cwd: source, env: pushEnv },
      );
      expect(unknown.code).not.toBe(0);
      expect(unknown.output).toContain("hoist apps:create unknown");
      expect(
        (await command([...ssh, remote, "apps:destroy hello"])).output,
      ).toContain("requires --force");
      await control("apps:destroy", "hello", "--force");
      expect(JSON.parse((await control("apps:list", "--json")).stdout)).toEqual(
        [],
      );
      expect(store.apps()).toEqual([]);
      expect(store.releases(app.id)).toEqual([]);
      for (const path of ["repos/hello.git", "releases/hello"])
        expect(await stat(join(data, path)).catch(() => null)).toBeNull();
      expect(await docker.listImages({ "hoist.app": "hello" })).toEqual([]);
      expect(await readdir(join(data, "tmp"))).toEqual([]);
      console.log(
        "README walkthrough verified: ssh … hoist apps:create hello; git remote add hoist ssh://…/hello.git; git push hoist main -> release v1, built; apps:destroy hello --force -> empty.",
      );
    } catch (error) {
      failures.push(error);
    }
    const attempt = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    await attempt(async () => {
      for (const image of await docker.listImages({ "hoist.app": "hello" }))
        await docker.removeImage(image);
    });
    if (sshd) {
      sshd.kill();
      await sshd.exited;
    }
    await attempt(async () => {
      expect(await listening(port)).toBe(false);
    });
    await attempt(async () => {
      expect(await docker.listContainers({ "hoist.app": "hello" })).toEqual([]);
      expect(await docker.listImages({ "hoist.app": "hello" })).toEqual([]);
    });
    store?.close();
    await rm(root, { recursive: true, force: true });
    expect(await stat(root).catch(() => null)).toBeNull();
    if (failures.length)
      throw new AggregateError(
        failures,
        `SSH harness failed\n${await sshdLogs}`,
      );
    console.log(
      "Teardown verified: SSH port refuses connections; 0 app containers and images; temp SSH keys, repos, logs and data removed.",
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
