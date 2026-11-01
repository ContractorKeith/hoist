import type { CaddyAdmin, CaddyConfig } from "../interfaces";

export class FakeCaddy implements CaddyAdmin {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly routes = new Map<string, string>();
  config: CaddyConfig = {};

  async loadConfig(config: CaddyConfig): Promise<void> {
    this.calls.push({ method: "loadConfig", args: [structuredClone(config)] });
    this.config = structuredClone(config);
    this.routes.clear();
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
