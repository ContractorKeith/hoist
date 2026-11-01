import type { CaddyAdmin, CaddyConfig } from "../interfaces";

export class FakeCaddy implements CaddyAdmin {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly routes = new Map<string, string>();
  config: CaddyConfig = {};

  async loadConfig(config: CaddyConfig): Promise<void> {
    this.calls.push({ method: "loadConfig", args: [structuredClone(config)] });
    this.config = structuredClone(config);
    this.routes.clear();
    const apps = config.apps as
      | {
          http?: {
            servers?: {
              hoist?: {
                routes?: {
                  match: { host: string[] }[];
                  handle: { upstreams: { dial: string }[] }[];
                }[];
              };
            };
          };
        }
      | undefined;
    for (const route of apps?.http?.servers?.hoist?.routes ?? []) {
      const host = route.match[0]?.host[0],
        dial = route.handle[0]?.upstreams[0]?.dial;
      if (host && dial) this.routes.set(host, dial);
    }
  }
  async upsertRoute(host: string, upstream: string): Promise<void> {
    this.calls.push({ method: "upsertRoute", args: [host, upstream] });
    this.routes.set(host, upstream);
  }
  async removeRoute(host: string): Promise<void> {
    this.calls.push({ method: "removeRoute", args: [host] });
    this.routes.delete(host);
  }
}
