import { join } from "node:path";
import { SqliteAppLocks } from "./adapters/app-lock";
import { Caddy } from "./adapters/caddy";
import { ensureCaddy } from "./adapters/caddy-binary";
import { Docker } from "./adapters/docker";
import { checkHealth } from "./adapters/health";
import { stopOrphanCaddy } from "./adapters/orphan-caddy";
import { stopChild } from "./adapters/process";
import { port } from "./adapters/validation";
import { bootRoutes } from "./core/boot-routes";
import {
  type CaddySettings,
  caddyConfig,
  newestRoutes,
} from "./core/caddy-config";
import { previewTTL, sweepPreviews } from "./core/previews";
import { reconcile } from "./core/reconcile";
import { dataRoot, privatePath } from "./data";
import { finishSupervisor, scheduleSweep } from "./preview-timer";
import { SqliteStore } from "./store/sqlite";
import { dashboardRoute, startDashboard } from "./web/server";

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
  const ttl = previewTTL();
  const startedAt = new Date().toISOString();
  const root = dataRoot(),
    settings = caddySettings(root);
  const dashboard = dashboardRoute();
  if (
    [settings.adminPort, settings.httpPort, settings.httpsPort].includes(
      dashboard.port,
    )
  )
    throw new Error("Dashboard and Caddy ports must be distinct");
  const store = new SqliteStore(root),
    docker = new Docker(),
    caddy = new Caddy(settings.adminPort);
  const locks = new SqliteAppLocks(store);
  const shutdown = new AbortController();
  let lease: Awaited<ReturnType<SqliteAppLocks["acquire"]>> | undefined;
  let web: ReturnType<typeof startDashboard> | undefined;
  let stopping = false;
  let stoppingChild: Promise<void> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const sweeper = scheduleSweep(() =>
    sweepPreviews(
      root,
      store,
      docker,
      caddy,
      locks,
      Date.now(),
      ttl,
      console.error,
      shutdown.signal,
    ),
  );
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    shutdown.abort(new Error("hoist serve stopping"));
    if (child) stoppingChild ??= stopChild(child);
    wake?.();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    lease = await locks.acquire("serve", {
      failFast: true,
      signal: shutdown.signal,
    });
    shutdown.signal.throwIfAborted();
    await docker.ping();
    web = startDashboard(root, store, docker, { signal: shutdown.signal });
    const binary = await ensureCaddy();
    const configPath = privatePath(
      join(root, "caddy.json"),
      false,
      false,
      root,
    );
    privatePath(join(root, "caddy"), true, false, root);
    await stopOrphanCaddy(lease.previousChildPid, binary, configPath);
    lease.setChild(null);
    let backoff = 100;
    let boot = true;
    let fastExits = 0;
    while (!stopping) {
      // Rebuild from the store on each restart; never replay a stale file after cutover.
      const routes = await bootRoutes(store, docker, dashboard, console.error);
      await Bun.write(
        configPath,
        JSON.stringify(caddyConfig(settings, newestRoutes(routes), dashboard)),
      );
      const childStarted = Date.now();
      child = Bun.spawn([binary, "run", "--config", configPath], {
        env: { ...process.env, XDG_DATA_HOME: root, XDG_CONFIG_HOME: root },
        stdout: "inherit",
        stderr: "pipe",
      });
      lease.setChild(child.pid);
      const current = child;
      const tail: string[] = [];
      const stderrDone = (async () => {
        let pending = "";
        const decoder = new TextDecoder();
        for await (const chunk of current.stderr as ReadableStream<Uint8Array>) {
          await Bun.write(Bun.stderr, chunk).catch(() => {});
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          tail.push(...lines);
          if (tail.length > 50) tail.splice(0, tail.length - 50);
          if (pending.length > 65536) pending = pending.slice(-65536);
        }
        if (pending) tail.push(pending);
        if (tail.length > 50) tail.splice(0, tail.length - 50);
      })();
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
            locks,
            checkHealth,
            startedAt,
            console.error,
            shutdown.signal,
            dashboard,
          );
          boot = false;
          sweeper.start();
        }
        if (!stopping) console.error("hoist serve ready");
      }
      if (!ready && child.exitCode === null) await stopChild(child);
      const code = await child.exited;
      lease.setChild(null);
      await stderrDone;
      if (stoppingChild) await stoppingChild;
      stoppingChild = undefined;
      if (!stopping) {
        if (Date.now() - childStarted >= 10000) {
          backoff = 100;
          fastExits = 0;
        } else fastExits++;
        if (fastExits >= 5)
          throw new Error(
            `Caddy exited with code ${code} five consecutive times under 10 s; last stderr lines:\n${tail.join("\n")}`,
          );
        console.error(
          `Caddy exited with code ${code}; restarting in ${backoff} ms`,
        );
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
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    stopping = true;
    shutdown.abort();
    await finishSupervisor(
      () => sweeper.cancel(),
      async () => {
        if (child) await (stoppingChild ?? stopChild(child));
      },
      () => {
        if (child) lease?.setChild(null);
      },
    );
    await web?.stop();
    lease?.release();
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    store.close();
  }
}
