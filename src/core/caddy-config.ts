import type { CaddyConfig } from "../adapters/interfaces";

export interface CaddySettings {
  adminPort: number;
  httpPort: number;
  httpsPort: number;
  tls: "acme" | "internal";
  email?: string;
  dataDir: string;
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
  routes: { host: string; upstream: string }[],
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
            routes: routes.map((item) => route(item.host, item.upstream)),
          },
        },
      },
    },
  };
}
