import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { caddyRelease } from "../adapters/caddy-binary";
import { Docker } from "../adapters/docker";
import type { DockerClient } from "../adapters/interfaces";
import { port } from "../adapters/validation";
import { dashboardHost } from "../core/caddy-config";
import { releaseHost } from "../core/previews";
import { repairRepoHooks } from "../git/repository";
import { caddySettings } from "../server";
import { DashboardStore } from "../store/dashboard";
import type { SqliteStore } from "../store/sqlite";

export class ServiceUnavailable extends Error {}
export type Check = () => unknown | Promise<unknown>;
const caddyFix = "Re-run install.sh to restore pinned Caddy.";
const requireCheck = (condition: unknown, fix: string) => {
  if (!condition) throw new Error(fix);
};
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
export function doctorChecks(
  root: string,
  source: SqliteStore | (() => SqliteStore),
  docker?: DockerClient,
  request = fetch,
): Record<string, Check> {
  const store = () => (typeof source === "function" ? source() : source);
  const client = () => (docker ??= new Docker());
  const releases = () =>
    store()
      .apps()
      .flatMap((app) => store().releases(app.id));
  const admin = async (path: string) => {
    const url = `http://127.0.0.1:${caddySettings(root).adminPort}${path}`;
    const response = await request(url, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => {
      throw new ServiceUnavailable(
        "Start hoist serve so the Caddy admin API answers.",
      );
    });
    requireCheck(response.ok, "Restore the Caddy admin API configuration.");
    return response;
  };
  return {
    Docker: () => client().ping(),
    "Caddy binary": async () => {
      const pin =
        caddyRelease.linux[process.arch as keyof typeof caddyRelease.linux];
      requireCheck(
        process.platform === "linux" && pin,
        "Install on Linux x64 or arm64.",
      );
      const path = join(
        homedir(),
        `.cache/hoist/caddy/${caddyRelease.version}/caddy`,
      );
      const hash = new Bun.CryptoHasher("sha256")
        .update(
          await Bun.file(path)
            .arrayBuffer()
            .catch((error) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT")
                throw new Error(caddyFix);
              throw error;
            }),
        )
        .digest("hex");
      requireCheck(hash === pin.binarySha256, caddyFix);
      await access(path, constants.X_OK);
    },
    Git: () => requireCheck(Bun.which("git"), "Install git on PATH."),
    Tar: () => requireCheck(Bun.which("tar"), "Install tar on PATH."),
    "Data directory": async () => {
      requireCheck(isAbsolute(root), "Set HOIST_DIR to an absolute path.");
      const directory = await stat(root);
      requireCheck(
        directory.isDirectory() && (directory.mode & 0o7777) === 0o700,
        "Create HOIST_DIR with mode 0700.",
      );
      await access(root, constants.R_OK | constants.W_OK | constants.X_OK);
    },
    Database: () => store().migrate(),
    "Secret key": async () => {
      await store().secretKey(true);
    },
    "Serve lease": () => {
      const lease = store().lock("serve");
      requireCheck(
        lease &&
          alive(lease.owner_pid) &&
          Date.parse(lease.heartbeat_at) > Date.now() - 60000,
        "Start hoist serve to hold a live serve lease.",
      );
    },
    "Caddy admin": async () => {
      await (await admin("/config/")).body?.cancel();
    },
    "TLS and ports": () => {
      const settings = caddySettings(root);
      const dashboard = Number(process.env.HOIST_DASHBOARD_PORT ?? 8700);
      port(dashboard);
      requireCheck(
        ![settings.adminPort, settings.httpPort, settings.httpsPort].includes(
          dashboard,
        ),
        "Set distinct valid dashboard and Caddy ports.",
      );
    },
    Hooks: async () => {
      requireCheck(isAbsolute(root), "Set HOIST_DIR to an absolute path.");
      return (await repairRepoHooks(root)).join("; ");
    },
    "Orphan containers": async () => {
      const known = new Set(
        store()
          .apps()
          .flatMap((app) =>
            store()
              .releases(app.id)
              .map((r) => `${r.container_id}/${app.name}/${r.id}`),
          ),
      );
      const orphans = (await client().listContainers({})).filter(
        (c) =>
          c.labels["hoist.app"] &&
          !known.has(
            `${c.id}/${c.labels["hoist.app"]}/${c.labels["hoist.release"]}`,
          ),
      );
      requireCheck(
        !orphans.length,
        `Remove orphan containers: ${orphans.map((c) => c.id).join(", ")}.`,
      );
    },
    "Orphan images": async () => {
      // ping/listContainers accept no signal; bound this separate image request to 5 s.
      const groups = await Promise.all(
        [{ label: ["hoist.app"] }, { reference: ["hoist/*"] }].map(
          async (filters) => {
            const response = await request(
              `http://localhost/v1.47/images/json?all=true&filters=${encodeURIComponent(JSON.stringify(filters))}`,
              {
                unix: (
                  process.env.DOCKER_HOST ?? "/var/run/docker.sock"
                ).replace(/^unix:\/\//, ""),
                signal: AbortSignal.timeout(5000),
              },
            );
            requireCheck(
              response.ok,
              "Restore Docker access to inspect orphan images.",
            );
            return (await response.json()) as {
              Id: string;
              RepoTags?: string[];
              Labels?: Record<string, string>;
            }[];
          },
        ),
      );
      const images = [
        ...new Map(groups.flat().map((image) => [image.Id, image])).values(),
      ];
      const tags = new Set(releases().map((r) => r.image));
      const orphans = images
        .filter(
          (i) =>
            i.Labels?.["hoist.app"] ||
            i.RepoTags?.some((t) => t.startsWith("hoist/")),
        )
        .filter((i) => !i.RepoTags?.some((t) => tags.has(t)));
      requireCheck(
        !orphans.length,
        `Remove orphan images: ${orphans.map((i) => i.Id).join(", ")}.`,
      );
    },
    "Orphan routes": async () => {
      const hosts = new Set([
        dashboardHost(),
        ...store()
          .apps()
          .flatMap((app) =>
            store()
              .releases(app.id)
              .filter((r) => r.status === "live")
              .map((r) => releaseHost(app, r.branch)),
          ),
      ]);
      const routes = (await (
        await admin("/config/apps/http/servers/hoist/routes")
      ).json()) as { "@id"?: string; match?: { host?: string[] }[] }[];
      const orphans = routes.flatMap((r) => {
        const names = r.match?.flatMap((m) => m.host ?? []) ?? [];
        return names.length
          ? names.filter((host) => !hosts.has(host))
          : [r["@id"] ?? "route without a host"];
      });
      requireCheck(
        !orphans.length,
        `Remove orphan Caddy routes: ${orphans.join(", ")}.`,
      );
    },
    "Dashboard password": () =>
      requireCheck(
        new DashboardStore(store().db).password(),
        "Run hoist dashboard:set-password to set the owner password.",
      ),
  };
}
