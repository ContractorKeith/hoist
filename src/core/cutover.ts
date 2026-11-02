import type { CaddyAdmin, DockerClient, Labels } from "../adapters/interfaces";
import type { App, Release, Store } from "../store/interface";
import { decryptConfig } from "./secrets";
import { healthPath } from "./validation";

export type HealthCheck = (port: number, path: string) => Promise<void>;
type Log = (message: string) => Promise<void>;
export function appPort(
  exposed: number[],
  config: Record<string, string>,
): number {
  if (exposed.length > 1 && config.PORT === undefined)
    throw new Error("image exposes several ports; set PORT in config");
  const port = exposed.length === 1 ? exposed[0] : Number(config.PORT ?? 8080);
  if (!port || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid app port");
  return port;
}

export function ownsContainer(
  container: { labels: Labels } | null,
  app: App,
  release: Release,
): boolean {
  return (
    !!container &&
    container.labels["hoist.app"] === app.name &&
    container.labels["hoist.release"] === String(release.id)
  );
}

async function startHealthy(
  store: Store,
  docker: DockerClient,
  caddy: CaddyAdmin,
  app: App,
  release: Release,
  health: HealthCheck,
  log: Log,
): Promise<string> {
  let id: string | undefined;
  try {
    healthPath(app.health_path);
    const config = await decryptConfig(store, release.config_json);
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
    const container = await docker.inspectContainer(id, port);
    if (!container?.running || !ownsContainer(container, app, release))
      throw new Error("New container is not running");
    await log(`Health check GET ${app.health_path}`);
    await health(container.port, app.health_path);
    await log("Swapping Caddy upstream");
    await caddy.upsertRoute(app.domain, `127.0.0.1:${container.port}`);
    return id;
  } catch (error) {
    if (id) {
      await docker.stopContainer(id).catch(() => {});
      await docker.removeContainer(id);
    }
    throw error;
  }
}

export async function cutover(
  store: Store,
  docker: DockerClient,
  caddy: CaddyAdmin,
  app: App,
  release: Release,
  expectedOldTip: string | null,
  head: () => Promise<string | null>,
  health: HealthCheck,
  log: Log = async () => {},
): Promise<void> {
  if (release.status !== "built")
    throw new Error("Cutover requires a built release");
  const tip = await head();
  if (tip !== expectedOldTip) {
    store.failRelease(release.id);
    throw new Error(
      `branch ${release.branch} tip is ${tip?.slice(0, 12) ?? "missing"}, not this release; skipping cutover (branch moved)`,
    );
  }
  let id: string;
  try {
    id = await startHealthy(store, docker, caddy, app, release, health, log);
  } catch (error) {
    store.failRelease(release.id);
    await log(error instanceof Error ? error.message : String(error)).catch(
      () => {},
    );
    throw error;
  }
  const old = store
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

export async function recoverLive(
  store: Store,
  docker: DockerClient,
  caddy: CaddyAdmin,
  app: App,
  release: Release,
  health: HealthCheck,
  report: (message: string) => void = console.error,
): Promise<void> {
  if (release.status !== "live")
    throw new Error("Recovery requires a live release");
  const oldId = release.container_id;
  const old = oldId ? await docker.inspectContainer(oldId) : null;
  const owned = ownsContainer(old, app, release);
  if (old && !owned)
    report(
      `${app.name} release ${release.id}: container ${oldId} ownership does not match; recovering`,
    );
  const id = await startHealthy(
    store,
    docker,
    caddy,
    app,
    release,
    health,
    async () => {},
  );
  store.setReleaseState(release.id, "live", id, "live");
  // Recovery never stops the old container: it was missing or stopped already.
  if (oldId && oldId !== id && old && owned)
    await docker.removeContainer(oldId);
}
