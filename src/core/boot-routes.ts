import type { DockerClient } from "../adapters/interfaces";
import { hostName } from "../adapters/validation";
import type { Store } from "../store/interface";
import { dashboardRouteGuard, type ReleaseRoute } from "./caddy-config";
import { ownsContainer } from "./cutover";
import { releaseHost } from "./previews";

export async function bootRoutes(
  store: Store,
  docker: DockerClient,
  dashboard: ReleaseRoute,
  report: (message: string) => void,
): Promise<ReleaseRoute[]> {
  const routes: ReleaseRoute[] = [],
    allowed = dashboardRouteGuard(dashboard, report);
  for (const app of store.apps()) {
    try {
      hostName(app.domain);
      for (const release of store
        .releases(app.id)
        .filter((row) => row.status === "live")) {
        try {
          const host = releaseHost(app, release.branch);
          if (!allowed(app.name, host)) continue;
          const info = release.container_id
            ? await docker.inspectContainer(release.container_id)
            : null;
          if (info?.running && ownsContainer(info, app, release))
            routes.push({
              host,
              upstream: `127.0.0.1:${info.port}`,
              releaseId: release.id,
              appName: app.name,
            });
        } catch (error) {
          report(`${app.name} release ${release.id}: ${String(error)}`);
        }
      }
    } catch (error) {
      report(`${app.name}: ${String(error)}`);
    }
  }
  return routes;
}
