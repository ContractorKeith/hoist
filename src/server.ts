import { join } from "node:path";
import { Caddy } from "./adapters/caddy";
import { ensureCaddy } from "./adapters/caddy-binary";
import { Docker } from "./adapters/docker";
import { checkHealth } from "./adapters/health";
import { hostName, port } from "./adapters/validation";
import { type CaddySettings, caddyConfig } from "./core/caddy-config";
import { reconcile } from "./core/reconcile";
import { dataRoot, privatePath } from "./data";
import { SqliteStore } from "./store/sqlite";

export function caddySettings(root: string): CaddySettings {
  const tls = process.env.HOIST_TLS ?? "acme";
  if (tls !== "acme" && tls !== "internal")
    throw new Error("HOIST_TLS must be acme or internal");
  const settings: CaddySettings = {
    adminPort: Number(process.env.HOIST_CADDY_ADMIN_PORT ?? 2019),
    httpPort: Number(process.env.HOIST_HTTP_PORT ?? 80),
    httpsPort: Number(process.env.HOIST_HTTPS_PORT ?? 443),
    tls,
    email: process.env.HOIST_ACME_EMAIL,
    dataDir: root,
  };
  for (const value of [
    settings.adminPort,
    settings.httpPort,
    settings.httpsPort,
  ])
    port(value);
  if (
    new Set([settings.adminPort, settings.httpPort, settings.httpsPort])
      .size !== 3
  )
    throw new Error("Caddy ports must be distinct");
  return settings;
}

export async function serve(): Promise<void> {
  const startedAt = new Date().toISOString();
  const root = dataRoot(),
    settings = caddySettings(root);
  const store = new SqliteStore(root),
    docker = new Docker(),
    caddy = new Caddy(settings.adminPort);
  let stopping = false;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    child?.kill("SIGTERM");
    wake?.();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await docker.ping();
    const binary = await ensureCaddy();
    const configPath = privatePath(
      join(root, "caddy.json"),
      false,
      false,
      root,
    );
    privatePath(join(root, "caddy"), true, false, root);
    let backoff = 100;
    let boot = true;
    while (!stopping) {
      // Rebuild from the store on each restart; never replay a stale file after cutover.
      const routes: { host: string; upstream: string }[] = [];
      for (const app of store.apps()) {
        hostName(app.domain);
        for (const release of store
          .releases(app.id)
          .filter((row) => row.status === "live")) {
          const info = release.container_id
            ? await docker.inspectContainer(release.container_id)
            : null;
          if (info?.running)
            routes.push({
              host: app.domain,
              upstream: `127.0.0.1:${info.port}`,
            });
        }
      }
      await Bun.write(
        configPath,
        JSON.stringify(caddyConfig(settings, routes)),
      );
      const childStarted = Date.now();
      child = Bun.spawn([binary, "run", "--config", configPath], {
        env: { ...process.env, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root },
        stdout: "inherit",
        stderr: "inherit",
      });
      let ready = false;
      for (
        let attempt = 0;
        attempt < 100 && !stopping && child.exitCode === null;
        attempt++
      ) {
        try {
          const response = await fetch(
            `http://127.0.0.1:${settings.adminPort}/config/`,
            { signal: AbortSignal.timeout(200) },
          );
          await response.body?.cancel();
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {
          /* Caddy has not bound its admin listener yet. */
        }
        await Bun.sleep(50);
      }
      if (ready && !stopping) {
        if (boot) {
          await reconcile(
            store,
            docker,
            caddy,
            settings,
            checkHealth,
            startedAt,
          );
          boot = false;
        }
        console.error("hoist serve ready");
      }
      if (!ready && child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
      if (!stopping) {
        if (Date.now() - childStarted >= 10000) backoff = 100;
        console.error(`Caddy exited; restarting in ${backoff} ms`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, backoff);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        backoff = Math.min(backoff * 2, 5000);
      }
    }
  } finally {
    if (child?.exitCode === null) child.kill("SIGTERM");
    if (child) await child.exited;
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    store.close();
  }
}
