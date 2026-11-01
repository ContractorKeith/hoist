import type { CaddyAdmin, DockerClient } from "../adapters/interfaces";
import type { App, Release, Store } from "../store/interface";
import { healthPath } from "./validation";

export type HealthCheck = (port: number, path: string) => Promise<void>;

export function appPort(
  exposed: number[],
  config: Record<string, string>,
): number {
  const port =
    exposed.length === 1 && exposed[0]
      ? exposed[0]
      : Number(config.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid app port");
  return port;
}

// Reconcile uses the same start/health/swap path, preserving the live row on failure.
export async function cutover(
  store: Store,
  docker: DockerClient,
  caddy: CaddyAdmin,
  app: App,
  release: Release,
  head: () => Promise<string | null>,
  health: HealthCheck,
  log: (message: string) => Promise<void> = async () => {},
  recovering = false,
  expectedTip: string | null = release.git_sha,
): Promise<void> {
  if (release.status !== (recovering ? "live" : "built"))
    throw new Error("Cutover requires a built release");
  if (!recovering) {
    const tip = await head();
    if (tip !== expectedTip) {
      store.failRelease(release.id);
      throw new Error(
        `branch ${release.branch} tip is ${tip?.slice(0, 12) ?? "missing"}, not this release; skipping cutover`,
      );
    }
  }
  let id: string | undefined;
  try {
    healthPath(app.health_path);
    const config = JSON.parse(release.config_json) as Record<string, string>;
    const port = appPort(await docker.imagePorts(release.image), config);
    await log("Starting new container");
    id = await docker.createContainer({
      image: release.image,
      config,
      port,
      publishPort: "",
      labels: {
        "hoist.app": app.name,
        "hoist.release": String(release.id),
        "hoist.branch": release.branch,
      },
    });
    await docker.startContainer(id);
    const container = await docker.inspectContainer(id);
    if (!container?.running) throw new Error("New container is not running");
    await log(`Health check GET ${app.health_path}`);
    await health(container.port, app.health_path);
    await log("Swapping Caddy upstream");
    await caddy.upsertRoute(app.domain, `127.0.0.1:${container.port}`);
  } catch (error) {
    if (!recovering) store.failRelease(release.id);
    await log(error instanceof Error ? error.message : String(error)).catch(
      () => {},
    );
    if (id) {
      await docker.stopContainer(id).catch(() => {});
      await docker.removeContainer(id);
    }
    throw error;
  }
  // Once traffic moves, cleanup failures must never remove the new upstream.
  const old = recovering
    ? []
    : store
        .releases(app.id)
        .filter(
          (row) =>
            row.status === "live" &&
            row.branch === release.branch &&
            row.id !== release.id,
        );
  for (const row of old) {
    await log("Stopping previous container");
    if (row.container_id) {
      try {
        await docker.stopContainer(row.container_id);
        await docker.removeContainer(row.container_id);
      } catch (error) {
        // Reconcile will remove this unreferenced container on the next boot.
        await log(`Previous container cleanup failed: ${String(error)}`);
      }
    }
  }
  store.transaction(() => {
    for (const row of old) store.setReleaseState(row.id, "stopped");
    store.setReleaseState(release.id, "live", id);
  });
  await log(`Live: https://${app.domain}`);
}
