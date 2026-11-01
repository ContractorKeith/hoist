import type {
  AppLocks,
  CaddyAdmin,
  DockerClient,
} from "../adapters/interfaces";
import type { Store } from "../store/interface";
import { removeImages } from "./build";
import {
  type CaddySettings,
  caddyConfig,
  newestRoutes,
  type ReleaseRoute,
} from "./caddy-config";
import { type HealthCheck, recoverLive } from "./cutover";

export async function reconcile(
  store: Store,
  docker: DockerClient,
  caddy: CaddyAdmin,
  settings: CaddySettings,
  locks: AppLocks,
  health: HealthCheck,
  startedAt = new Date().toISOString(),
  report: (message: string) => void = console.error,
): Promise<string[]> {
  const errors: string[] = [],
    routes: ReleaseRoute[] = [];
  const record = (context: string, error: unknown) => {
    const message = `${context}: ${String(error)}`;
    errors.push(message);
    report(message);
  };
  for (const app of store.apps()) {
    try {
      await locks.withLock(app.name, async () => {
        for (const release of store.releases(app.id)) {
          try {
            if (
              release.status === "building" &&
              (!release.created_at || release.created_at <= startedAt)
            ) {
              store.failRelease(release.id);
              await removeImages(docker, {
                "hoist.app": app.name,
                "hoist.release": String(release.id),
              });
            }
            if (release.status !== "live") continue;
            const container = release.container_id
              ? await docker.inspectContainer(release.container_id)
              : null;
            if (!container?.running)
              await recoverLive(store, docker, caddy, app, release, health);
          } catch (error) {
            record(`${app.name} release ${release.id}`, error);
          }
        }
        // Failed recovery for one release must not hide other running routes.
        for (const release of store
          .releases(app.id)
          .filter((row) => row.status === "live")) {
          try {
            const running = release.container_id
              ? await docker.inspectContainer(release.container_id)
              : null;
            if (running?.running)
              routes.push({
                host: app.domain,
                upstream: `127.0.0.1:${running.port}`,
                releaseId: release.id,
              });
          } catch (error) {
            record(`${app.name} route ${release.id}`, error);
          }
        }
        const releases = store.releases(app.id);
        for (const container of await docker.listContainers({
          "hoist.app": app.name,
        })) {
          const referenced = releases.some(
            (row) =>
              row.status !== "failed" &&
              row.status !== "stopped" &&
              (row.container_id === container.id ||
                String(row.id) === container.labels["hoist.release"]),
          );
          if (!referenced) {
            await docker.stopContainer(container.id);
            await docker.removeContainer(container.id);
          }
        }
      });
    } catch (error) {
      record(app.name, error);
    }
  }
  try {
    await caddy.loadConfig(caddyConfig(settings, newestRoutes(routes)));
  } catch (error) {
    record("Caddy config", error);
  }
  // Apps removed from the store may still have labelled containers. Never touch an active lock.
  try {
    const known = new Set(store.apps().map((app) => app.name));
    for (const container of await docker.listContainers({})) {
      const name = container.labels["hoist.app"];
      if (!name || known.has(name) || locks.isLocked(name)) continue;
      try {
        await locks.withLock(name, async () => {
          if (!store.app(name)) {
            await docker.stopContainer(container.id);
            await docker.removeContainer(container.id);
          }
        });
      } catch (error) {
        record(`orphan ${container.id}`, error);
      }
    }
  } catch (error) {
    record("orphan sweep", error);
  }
  return errors;
}
