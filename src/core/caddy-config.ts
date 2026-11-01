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
): CaddyConfig {
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
            routes: newestRoutes(routes).map((item) =>
              route(item.host, item.upstream),
            ),
          },
        },
      },
    },
  };
}
