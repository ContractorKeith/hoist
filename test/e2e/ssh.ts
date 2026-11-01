import { expect } from "bun:test";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { Docker } from "../../src/adapters/docker";
import { removeImages } from "../../src/core/build";
import { SqliteStore } from "../../src/store/sqlite";
import { eventually, reservePorts } from "./harness";

const cli = resolve(import.meta.dir, "../../src/cli/index.ts");
export async function command(
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
export async function ok(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = await command(args, options);
  if (result.code)
    throw new Error(`${args.join(" ")} failed: ${result.output}`);
  return result;
}
export async function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function withSSH(
  run: (h: Awaited<ReturnType<typeof startSSH>>) => Promise<void>,
  executable?: string,
) {
  const harness = await startSSH(executable);
  const failures: unknown[] = [];
  try {
    await run(harness);
  } catch (error) {
    failures.push(error);
  }
  try {
    await harness.cleanup();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, "SSH/Caddy harness failed");
}

async function startSSH(executable?: string) {
  const entry = executable ? [executable] : [process.execPath, cli];
  if (process.platform !== "linux") throw new Error("E2e requires Linux");
  const docker = new Docker();
  await docker.ping();
  const root = await mkdtemp(join(tmpdir(), "hoist-ssh-"));
  const data = join(root, "data"),
    source = join(root, "source");
  const lease = await reservePorts(4);
  const [sshPort, admin, http, https] = lease.ports as [
    number,
    number,
    number,
    number,
  ];
  const env = {
    ...process.env,
    HOIST_DIR: data,
    HOIST_DOMAIN: "example.test",
    HOIST_TLS: "internal",
    HOIST_CADDY_ADMIN_PORT: String(admin),
    HOIST_HTTP_PORT: String(http),
    HOIST_HTTPS_PORT: String(https),
  };
  let sshd: ReturnType<typeof Bun.spawn> | undefined,
    server: ReturnType<typeof Bun.spawn> | undefined;
  let logs = "",
    serverLogs: Promise<void> | undefined;
  let leaseReleased = false;
  let store: SqliteStore | undefined;
  const stopServe = async () => {
    if (server) {
      server.kill("SIGTERM");
      await server.exited;
      await serverLogs;
      expect(server.exitCode).toBe(0);
      server = undefined;
    }
  };
  const cleanup = async () => {
    const errors: unknown[] = [];
    const attempt = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    };
    await attempt(stopServe);
    if (sshd) {
      sshd.kill();
      await sshd.exited;
    }
    if (!leaseReleased) await lease.release();
    await attempt(async () => {
      for (const container of await docker.listContainers({
        "hoist.app": "hello",
      }))
        await docker.removeContainer(container.id);
    });
    await attempt(async () => {
      await removeImages(docker, { "hoist.app": "hello" });
    });
    for (const port of lease.ports)
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
    if (errors.length)
      throw new AggregateError(errors, `Teardown failed\n${logs}`);
    console.log(
      "Teardown verified: hoist and Caddy exited; SSH, HTTP, HTTPS and admin ports refuse connections; 0 app containers and images; repos, rows and temporary files removed.",
    );
  };
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
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    const assignments = Object.entries(env)
      .filter(([key]) => key.startsWith("HOIST_") || key === "TMPDIR")
      .map(([key, value]) => `${key}=${quote(value ?? "")}`)
      .join(" ");
    const forced = `${assignments} ${entry.map(quote).join(" ")} ssh-dispatch`
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    await writeFile(
      join(root, "authorized_keys"),
      `command="${forced}",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ${await readFile(join(root, "client.pub"), "utf8")}`,
    );
    const config = join(root, "sshd_config");
    await writeFile(
      config,
      `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${root}/host\nAuthorizedKeysFile ${root}/authorized_keys\nPidFile none\nUsePAM no\nStrictModes no\nPermitUserEnvironment no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nLogLevel VERBOSE\n`,
    );
    // Leases stay held throughout setup and are released immediately before spawning.
    await lease.release();
    leaseReleased = true;
    sshd = Bun.spawn(["/usr/sbin/sshd", "-D", "-e", "-f", config], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const startServe = async () => {
      server = Bun.spawn([...entry, "serve"], {
        env,
        stdout: "ignore",
        stderr: "pipe",
      });
      const child = server;
      let ready = false;
      serverLogs = (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
          const text = decoder.decode(chunk);
          logs += text;
          if (text.includes("hoist serve ready")) ready = true;
        }
      })();
      await eventually(async () => {
        if (child.exitCode !== null) throw new Error(`serve exited\n${logs}`);
        expect(ready).toBe(true);
      }, 30000);
      return child;
    };
    await startServe();
    await eventually(async () => {
      expect(await listening(sshPort)).toBe(true);
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
      String(sshPort),
    ];
    const remote = `${userInfo().username}@127.0.0.1`;
    const control = (...args: string[]) =>
      ok([...ssh, remote, "hoist", ...args]);
    await cp(resolve(import.meta.dir, "../fixtures/hello"), source, {
      recursive: true,
    });
    await ok(["git", "init", "--initial-branch=main"], { cwd: source });
    const commit = async () => {
      await ok(["git", "add", "."], { cwd: source });
      await ok(
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
      return (
        await ok(["git", "rev-parse", "HEAD"], { cwd: source })
      ).stdout.trim();
    };
    await commit();
    await ok(
      ["git", "remote", "add", "hoist", `ssh://${remote}:${sshPort}/hello.git`],
      { cwd: source },
    );
    const pushEnv = {
      ...env,
      GIT_SSH_COMMAND: ssh
        .map((arg) => `'${arg.replace(/'/g, "'\\''")}'`)
        .join(" "),
    };
    const push = () =>
      command(["git", "push", "hoist", "main"], { cwd: source, env: pushEnv });
    const request = async () => {
      const ca = await readFile(
        join(data, "caddy/pki/authorities/local/root.crt"),
        "utf8",
      );
      return fetch(`https://127.0.0.1:${https}/`, {
        headers: { Host: "hello.example.test" },
        tls: { ca, serverName: "hello.example.test" },
        signal: AbortSignal.timeout(2000),
      });
    };
    store = new SqliteStore(data);
    return {
      root,
      data,
      source,
      docker,
      store,
      env,
      admin,
      http,
      https,
      ssh,
      remote,
      control,
      push,
      pushEnv,
      commit,
      request,
      startServe,
      stopServe,
      cleanup,
      getServer: () => server,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
