import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Caddy } from "../../src/adapters/caddy";
import { ensureCaddy } from "../../src/adapters/caddy-binary";
import { Docker } from "../../src/adapters/docker";
import type { CaddyConfig } from "../../src/adapters/interfaces";
import { SqliteStore } from "../../src/store/sqlite";
import { caddyLogs } from "./caddy-logs";

export async function highPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No port allocated");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function assertPortClosed(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(2000);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`Caddy port ${port} still accepts connections`));
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`Caddy port ${port} did not refuse connections`));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
}

export async function eventually(
  check: () => Promise<void>,
  timeout = 15000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(100);
    }
  }
}

export async function withHarness(
  run: (harness: {
    docker: Docker;
    caddy: Caddy;
    httpsPort: number;
    appPort: number;
    labels: Record<string, string>;
    tag: string;
    ca: string;
  }) => Promise<void>,
): Promise<void> {
  const docker = new Docker();
  const dataDir = await mkdtemp(join(tmpdir(), "hoist-e2e-"));
  const labels = { "hoist.test": crypto.randomUUID() };
  const tag = `hoist/hello:${labels["hoist.test"]}`;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let childLogs: Promise<string> | undefined;
  let store: SqliteStore | undefined;
  let caddyPorts: number[] = [];
  const failures: unknown[] = [];
  try {
    store = new SqliteStore(dataDir);
    await docker.ping();
    const binary = await ensureCaddy();
    const ports = new Set<number>();
    while (ports.size < 3) ports.add(await highPort());
    const [adminPort, httpsPort, appPort] = [...ports] as [
      number,
      number,
      number,
    ];
    caddyPorts = [adminPort, httpsPort];
    const caddy = new Caddy(adminPort);
    const config: CaddyConfig = {
      admin: { listen: `127.0.0.1:${adminPort}`, config: { persist: false } },
      storage: { module: "file_system", root: join(dataDir, "caddy") },
      apps: {
        pki: { certificate_authorities: { local: { install_trust: false } } },
        tls: {
          certificates: { automate: ["hello.test"] },
          automation: { policies: [{ issuers: [{ module: "internal" }] }] },
        },
        http: {
          servers: {
            hoist: {
              listen: [`127.0.0.1:${httpsPort}`],
              tls_connection_policies: [{}],
              automatic_https: { disable_redirects: true },
              routes: [],
            },
          },
        },
      },
    };
    const configPath = join(dataDir, "caddy.json");
    await Bun.write(configPath, JSON.stringify(config));
    const caddyProcess = Bun.spawn([binary, "run", "--config", configPath], {
      env: {
        ...process.env,
        XDG_DATA_HOME: dataDir,
        XDG_CONFIG_HOME: dataDir,
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    child = caddyProcess;
    childLogs = new Response(caddyProcess.stderr).text();
    await eventually(async () => {
      await caddy.loadConfig(config);
    });
    const ca = await readFile(
      join(dataDir, "caddy/pki/authorities/local/root.crt"),
      "utf8",
    );
    await run({ docker, caddy, httpsPort, appPort, labels, tag, ca });
  } catch (error) {
    failures.push(error);
  }
  {
    const teardownErrors: unknown[] = [];
    const attempt = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        teardownErrors.push(error);
      }
    };
    await attempt(async () => {
      for (const container of await docker.listContainers(labels))
        await docker.removeContainer(container.id);
    });
    await attempt(async () => {
      if ((await docker.listImages(labels)).length)
        await docker.removeImage(tag);
    });
    if (child) {
      const process = child;
      process.kill("SIGTERM");
      await Promise.race([process.exited, Bun.sleep(3000)]);
      if (process.exitCode === null) process.kill("SIGKILL");
      await Promise.race([process.exited, Bun.sleep(2000)]);
    }
    for (const port of caddyPorts) await attempt(() => assertPortClosed(port));
    await attempt(async () => {
      if ((await docker.listContainers(labels)).length)
        throw new Error("Leftover test containers");
    });
    await attempt(async () => {
      if ((await docker.listImages(labels)).length)
        throw new Error("Leftover test images");
    });
    await attempt(async () => {
      store?.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    failures.push(...teardownErrors);
  }
  if (failures.length === 0)
    console.log(
      "Teardown verified: Caddy admin and HTTPS ports refuse TCP connections; 0 containers and 0 images with hoist test label; temp data dir removed.",
    );

  if (failures.length)
    throw new AggregateError(
      failures,
      `Harness failed\n${await caddyLogs(child, childLogs)}`,
    );
}
