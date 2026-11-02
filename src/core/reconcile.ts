import type {
  AppLocks,
  CaddyAdmin,
  DockerClient,
} from "../adapters/interfaces";
import type { Store } from "../store/interface";
import { removeImages } from "./build";
import { type HealthCheck, ownsContainer, recoverLive } from "./cutover";
import { releaseHost } from "./previews";

export async function reconcile(
  store: Store,
  docker: DockerClient,
  caddy: CaddyAdmin,
  locks: AppLocks,
  health: HealthCheck,
  startedAt = new Date().toISOString(),
  report: (message: string) => void = console.error,
  signal?: AbortSignal,
): Promise<string[]> {
  const errors: string[] = [];
  const record = (context: string, error: unknown) => {
    const message = `${context}: ${String(error)}`;
    errors.push(message);
    report(message);
  };
  for (const candidate of store.apps()) {
    if (signal?.aborted) break;
    try {
      await locks.withLock(
        candidate.name,
        async () => {
          if (signal?.aborted) return;
          const app = store.app(candidate.name);
          if (!app) return;
          for (const release of store.releases(app.id)) {
            if (signal?.aborted) return;
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
              if (
                !container?.running ||
                !ownsContainer(container, app, release)
              )
                await recoverLive(
                  store,
                  docker,
                  caddy,
                  app,
                  release,
                  health,
                  report,
                  releaseHost(app, release.branch),
                );
            } catch (error) {
              record(`${app.name} release ${release.id}`, error);
            }
          }
          // Update only this app, while its lease excludes a concurrent cutover.
          const routes = new Map<string, string>();
          for (const release of store
            .releases(app.id)
            .filter((row) => row.status === "live")
            .sort((a, b) => b.id - a.id)) {
            try {
              const container = release.container_id
                ? await docker.inspectContainer(release.container_id)
                : null;
              if (
                container?.running &&
                ownsContainer(container, app, release)
              ) {
                const host = releaseHost(app, release.branch);
                if (!routes.has(host))
                  routes.set(host, `127.0.0.1:${container.port}`);
              }
            } catch (error) {
              record(`${app.name} route ${release.id}`, error);
            }
          }
          const hosts = new Set([
            app.domain,
            ...store
              .previews(app.id)
              .map((row) => releaseHost(app, row.branch)),
            ...routes.keys(),
          ]);
          for (const host of hosts) {
            try {
              const upstream = routes.get(host);
              if (upstream) await caddy.upsertRoute(host, upstream);
              else await caddy.removeRoute(host);
            } catch (error) {
              record(`${app.name} route ${host}`, error);
            }
          }
          const releases = store.releases(app.id);
          for (const container of await docker.listContainers({
            "hoist.app": app.name,
          })) {
            if (signal?.aborted) return;
            if (
              releases.some(
                (row) =>
                  row.status === "live" && row.container_id === container.id,
              )
            )
              continue;
            try {
              await docker.stopContainer(container.id);
              await docker.removeContainer(container.id);
              const row = releases.find(
                (row) => String(row.id) === container.labels["hoist.release"],
              );
              if (row?.status === "built") {
                store.failRelease(row.id);
                report(
                  `${app.name} release ${row.id}: interrupted before cutover`,
                );
              }
            } catch (error) {
              record(`orphan ${container.id}`, error);
            }
          }
        },
        signal,
      );
    } catch (error) {
      if (signal?.aborted) break;
      record(candidate.name, error);
    }
  }
  if (signal?.aborted) return errors;
  // Unknown apps may belong to an in-flight push; a live lease protects them.
  try {
    for (const container of await docker.listContainers({})) {
      if (signal?.aborted) break;
      const name = container.labels["hoist.app"];
      if (!name || store.app(name) || locks.isLocked(name)) continue;
      try {
        await locks.withLock(
          name,
          async () => {
            if (!store.app(name)) {
              await docker.stopContainer(container.id);
              await docker.removeContainer(container.id);
            }
          },
          signal,
        );
      } catch (error) {
        if (signal?.aborted) break;
        record(`orphan ${container.id}`, error);
      }
    }
  } catch (error) {
    record("orphan sweep", error);
  }
  return errors;
}
