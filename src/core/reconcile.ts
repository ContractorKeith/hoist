import type { CaddyAdmin, DockerClient } from "../adapters/interfaces";
import type { Store } from "../store/interface";
import { removeImages } from "./build";
import { type CaddySettings, caddyConfig } from "./caddy-config";
import { cutover, type HealthCheck } from "./cutover";

export async function reconcile(
  store: Store,
  docker: DockerClient,
  caddy: CaddyAdmin,
  settings: CaddySettings,
  health: HealthCheck,
  startedAt = new Date().toISOString(),
): Promise<void> {
  for (const app of store.apps()) {
    for (const release of store.releases(app.id)) {
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
    }
  }
  const routes: { host: string; upstream: string }[] = [];
  for (const app of store.apps()) {
    for (const release of store
      .releases(app.id)
      .filter((row) => row.status === "live")) {
      const container = release.container_id
        ? await docker.inspectContainer(release.container_id)
        : null;
      if (!container?.running) {
        await cutover(
          store,
          docker,
          caddy,
          app,
          release,
          async () => null,
          health,
          undefined,
          true,
        );
      }
      const current = store
        .releases(app.id)
        .find((row) => row.id === release.id);
      const running = current?.container_id
        ? await docker.inspectContainer(current.container_id)
        : null;
      if (running?.running)
        routes.push({
          host: app.domain,
          upstream: `127.0.0.1:${running.port}`,
        });
    }
  }
  await caddy.loadConfig(caddyConfig(settings, routes));
  const referenced = new Set(
    store.apps().flatMap((app) =>
      store
        .releases(app.id)
        .filter((row) => row.status === "live")
        .map((row) => row.container_id),
    ),
  );
  for (const container of await docker.listContainers({})) {
    if (container.labels["hoist.app"] && !referenced.has(container.id)) {
      await docker.stopContainer(container.id);
      await docker.removeContainer(container.id);
    }
  }
}
