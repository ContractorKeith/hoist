import { SqliteAppLocks } from "../adapters/app-lock";
import { Caddy } from "../adapters/caddy";
import { Docker } from "../adapters/docker";
import type {
  AppLocks,
  CaddyAdmin,
  DockerClient,
} from "../adapters/interfaces";
import { knownApp } from "../core/apps";
import { ownsContainer } from "../core/cutover";
import { reclassification, releaseHost, setMainBranch } from "../core/previews";
import { appName, branchSlug } from "../core/validation";
import { dataRoot } from "../data";
import { caddySettings } from "../server";
import type { Store } from "../store/interface";

export interface AppSetContext {
  store: Store;
  docker: DockerClient;
  caddy: CaddyAdmin;
  locks: AppLocks;
  write: (message: string) => void;
  warn: (message: string) => void;
}
export async function setAppBranch(
  store: Store,
  args: string[],
  context?: AppSetContext,
): Promise<void> {
  const name = appName(args[1] ?? "");
  const branch = (args[2] ?? "").slice(7);
  branchSlug(branch);
  const warn = context?.warn ?? console.error;
  await (context?.locks ?? new SqliteAppLocks(store)).withLock(
    name,
    async () => {
      const app = knownApp(store, name);
      const releases = store.releases(app.id);
      const updated = { ...app, main_branch: branch };
      reclassification(store, app, branch);
      try {
        const caddy =
          context?.caddy ?? new Caddy(caddySettings(dataRoot()).adminPort);
        const docker = context?.docker ?? new Docker();
        const routes = new Map<string, string>();
        for (const row of releases
          .filter((r) => r.status === "live")
          .sort((a, b) => b.id - a.id)) {
          const info = row.container_id
            ? await docker.inspectContainer(row.container_id)
            : null;
          const host = releaseHost(updated, row.branch);
          if (
            info?.running &&
            ownsContainer(info, app, row) &&
            !routes.has(host)
          )
            routes.set(host, `127.0.0.1:${info.port}`);
        }
        for (const [host, upstream] of routes)
          await caddy.upsertRoute(host, upstream);
        for (const host of new Set([
          app.domain,
          ...releases.map((row) => releaseHost(app, row.branch)),
          ...store.previews(app.id).map((row) => releaseHost(app, row.branch)),
        ]))
          if (!routes.has(host)) await caddy.removeRoute(host);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("Caddy admin API not reachable")
        )
          throw error;
        warn(
          "Caddy not reachable; routes are rebuilt from the store when hoist serve starts",
        );
      }
      setMainBranch(store, app, branch);
      (context?.write ?? console.log)(`Main branch for ${name}: ${branch}`);
    },
  );
}
