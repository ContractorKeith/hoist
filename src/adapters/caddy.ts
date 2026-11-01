import type { CaddyAdmin, CaddyConfig } from "./interfaces";
import * as validate from "./validation";

// The full config must contain an HTTP server named "hoist" with a routes array.
export class Caddy implements CaddyAdmin {
  private readonly base: string;
  private readonly routesPath = "/config/apps/http/servers/hoist/routes";

  constructor(port = 2019) {
    validate.port(port);
    this.base = `http://127.0.0.1:${port}`;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    allowConflict = false,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        signal: AbortSignal.timeout(30000),
        ...init,
        headers: { "Content-Type": "application/json", ...init.headers },
      });
    } catch (error) {
      throw new Error(
        `Caddy admin API not reachable at ${this.base}; is \`hoist serve\` running?`,
        { cause: error },
      );
    }
    if (!response.ok && !(allowConflict && response.status === 412))
      throw new Error(
        `Caddy ${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`,
      );
    return response;
  }

  async loadConfig(config: CaddyConfig): Promise<void> {
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
      for (const match of route.match)
        for (const host of match.host) validate.hostName(host);
      for (const handle of route.handle)
        for (const upstream of handle.upstreams)
          validate.upstreamAddress(upstream.dial);
    }
    await this.request("/load", {
      method: "POST",
      body: JSON.stringify(config),
    });
  }

  private async changeRoute(host: string, upstream?: string): Promise<void> {
    validate.hostName(host);
    if (upstream !== undefined) validate.upstreamAddress(upstream);
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await this.request(this.routesPath);
      const etag = response.headers.get("Etag");
      if (!etag) throw new Error("Caddy response missing Etag");
      const routes = (await response.json()) as Record<string, unknown>[];
      const id = `hoist-${host}`;
      const next = routes.filter((route) => route["@id"] !== id);
      if (upstream !== undefined)
        next.push({
          "@id": id,
          match: [{ host: [host] }],
          handle: [
            { handler: "reverse_proxy", upstreams: [{ dial: upstream }] },
          ],
          terminal: true,
        });
      const updated = await this.request(
        this.routesPath,
        {
          method: "PATCH",
          headers: { "If-Match": etag },
          body: JSON.stringify(next),
        },
        true,
      );
      await updated.body?.cancel();
      if (updated.status !== 412) return;
    }
    throw new Error("Caddy route update conflicted after 5 attempts");
  }

  async upsertRoute(host: string, upstream: string): Promise<void> {
    await this.changeRoute(host, upstream);
  }
  async removeRoute(host: string): Promise<void> {
    await this.changeRoute(host);
  }
}
