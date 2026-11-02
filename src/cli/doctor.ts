import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { caddyRelease } from "../adapters/caddy-binary";
import { Docker } from "../adapters/docker";
import type { DockerClient } from "../adapters/interfaces";
import { port } from "../adapters/validation";
import { dashboardHost } from "../core/caddy-config";
import { releaseHost } from "../core/previews";
import { dataRoot } from "../data";
import { repairRepoHooks } from "../git/repository";
import { caddySettings } from "../server";
import { DashboardStore } from "../store/dashboard";
import { SqliteStore } from "../store/sqlite";

class ServiceUnavailable extends Error {}

// The pinned binary digest proves the version without running an untrusted executable.
const caddyFix = "Re-run install.sh to restore pinned Caddy.";

export type Check = () => unknown | Promise<unknown>;
export interface DoctorResult {
  check: string;
  status: "ok" | "warning" | "error";
  message: string;
}
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
export async function runChecks(
  checks: Record<string, Check>,
  noService = false,
): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  for (const [check, run] of Object.entries(checks)) {
    let status: DoctorResult["status"] = "ok",
      message = `${check} is ready.`;
    try {
      const detail = await run();
      if (typeof detail === "string" && detail) message = detail;
    } catch (error) {
      const service =
        ["Serve lease", "Caddy admin"].includes(check) ||
        error instanceof ServiceUnavailable;
      status = noService && service ? "warning" : "error";
      message = String(error instanceof Error ? error.message : error).replace(
        /\s+/g,
        " ",
      );
      if (error && typeof error === "object" && "code" in error)
        message += ` Fix ${check.toLowerCase()} and rerun doctor.`;
    }
    results.push({ check, status, message });
  }
  return results;
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
        .update(await Bun.file(path).arrayBuffer())
        .digest("hex");
      requireCheck(hash === pin.binarySha256, caddyFix);
      await access(path, 1);
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
      await access(root, 3);
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
      // The adapter lists IDs only; tags and labels are needed to match immutable releases.
      const response = await request(
        "http://localhost/v1.47/images/json?all=true",
        {
          unix: (process.env.DOCKER_HOST ?? "/var/run/docker.sock").replace(
            /^unix:\/\//,
            "",
          ),
          signal: AbortSignal.timeout(30000),
        },
      );
      requireCheck(
        response.ok,
        "Restore Docker access to inspect orphan images.",
      );
      const images = (await response.json()) as {
        Id: string;
        RepoTags?: string[];
        Labels?: Record<string, string>;
      }[];
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
export async function doctor(args: string[]): Promise<number> {
  if (args.length > 2 || args.slice(1).some((arg) => arg !== "--json"))
    throw new Error("Usage: hoist doctor [--json]");
  let store: SqliteStore | undefined;
  const root = process.env.HOIST_DIR ?? "/var/lib/hoist";
  let results: DoctorResult[];
  try {
    const checks = doctorChecks(
      root,
      () => (store ??= new SqliteStore(dataRoot())),
    );
    results = await runChecks(
      checks,
      process.env.HOIST_DOCTOR_NO_SERVICE === "1",
    );
  } finally {
    store?.close();
  }
  console.log(
    args.includes("--json")
      ? JSON.stringify(results)
      : results.map((r) => `${r.status} ${r.check}: ${r.message}`).join("\n"),
  );
  return results.some((r) => r.status === "error") ? 1 : 0;
}
