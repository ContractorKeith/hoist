import type { CaddyConfig } from "../adapters/interfaces";

export interface CaddySettings {
  adminPort: number;
  httpPort: number;
  httpsPort: number;
  tls: "acme" | "internal";
  email?: string;
  dataDir: string;
}
export interface ReleaseRoute {
  host: string;
  upstream: string;
  releaseId?: number;
  appName?: string;
}
export function newestRoutes(routes: ReleaseRoute[]): ReleaseRoute[] {
  const hosts = new Map<string, ReleaseRoute>();
  for (const route of routes) {
    const previous = hosts.get(route.host);
    if (!previous || (route.releaseId ?? 0) >= (previous.releaseId ?? 0))
      hosts.set(route.host, route);
  }
  return [...hosts.values()];
}
export function route(host: string, upstream: string): Record<string, unknown> {
  return {
    "@id": `hoist-${host}`,
    match: [{ host: [host] }],
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial: upstream }] }],
    terminal: true,
  };
}
export function caddyConfig(
  settings: CaddySettings,
  routes: ReleaseRoute[],
  dashboard?: ReleaseRoute,
  report: (message: string) => void = console.error,
): CaddyConfig {
  const allowed = dashboardRouteGuard(dashboard, report);
  const appRoutes = routes.filter((item) =>
    allowed(item.appName ?? item.host, item.host),
  );
  return {
    admin: {
      listen: `127.0.0.1:${settings.adminPort}`,
      config: { persist: false },
    },
    storage: { module: "file_system", root: `${settings.dataDir}/caddy` },
    apps: {
      ...(settings.tls === "internal"
        ? {
            pki: {
              certificate_authorities: { local: { install_trust: false } },
            },
          }
        : {}),
      tls: {
        automation: {
          policies: [
            {
              issuers: [
                settings.tls === "internal"
                  ? { module: "internal" }
                  : {
                      module: "acme",
                      ca: "https://acme-v02.api.letsencrypt.org/directory",
                      ...(settings.email ? { email: settings.email } : {}),
                    },
              ],
            },
          ],
        },
      },
      http: {
        http_port: settings.httpPort,
        https_port: settings.httpsPort,
        servers: {
          hoist: {
            listen: [`:${settings.httpsPort}`],
            tls_connection_policies: [{}],
            routes: newestRoutes([
              ...appRoutes,
              ...(dashboard ? [dashboard] : []),
            ]).map((item) => route(item.host, item.upstream)),
          },
        },
      },
    },
  };
}

// Shared routing namespace: CLI host reservations and serve resolve the same host.
export function dashboardHost(): string {
  return (
    process.env.HOIST_DASHBOARD_HOST ??
    `hoist.${process.env.HOIST_DOMAIN ?? "localhost"}`
  );
}

// A dashboard host is never an app upstream, even for legacy rows or domain changes.
export function dashboardRouteGuard(
  dashboard: ReleaseRoute | undefined,
  report: (message: string) => void,
) {
  const reported = new Set<string>();
  return (name: string, host: string): boolean => {
    if (host !== dashboard?.host) return true;
    const key = `${name}:${host}`;
    if (!reported.has(key)) {
      reported.add(key);
      report(
        `app ${name} host ${host} collides with the dashboard; route suppressed`,
      );
    }
    return false;
  };
}

export function assertAppHost(host: string): void {
  if (host === dashboardHost())
    throw new Error(`host ${host} is reserved for the dashboard`);
}
