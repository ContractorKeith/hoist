import type { DockerClient } from "../adapters/interfaces";
import { hostName, port } from "../adapters/validation";
import { releasesCommand } from "../cli/releases";
import type { SqliteStore } from "../store/sqlite";
import { Actions } from "./actions";
import { securityHeaders } from "./http";
import { dashboard } from "./router";

export function dashboardRoute() {
  const host =
    process.env.HOIST_DASHBOARD_HOST ??
    `hoist.${process.env.HOIST_DOMAIN ?? "localhost"}`;
  hostName(host);
  const dashboardPort = Number(process.env.HOIST_DASHBOARD_PORT ?? 8700);
  port(dashboardPort);
  return { host, upstream: `127.0.0.1:${dashboardPort}`, port: dashboardPort };
}
export function startDashboard(
  root: string,
  store: SqliteStore,
  docker: DockerClient,
) {
  const route = dashboardRoute();
  const actions = new Actions((args) => releasesCommand(root, store, args));
  const handle = dashboard(store, docker, actions);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: route.port,
    idleTimeout: 0,
    maxRequestBodySize: 16384,
    fetch(request, server) {
      const peer = server.requestIP(request)?.address;
      if (peer !== "127.0.0.1" && peer !== "::1")
        return new Response("Loopback required", {
          status: 403,
          headers: securityHeaders,
        });
      if (request.headers.get("x-forwarded-proto") !== "https")
        return new Response("Caddy HTTPS required", {
          status: 403,
          headers: securityHeaders,
        });
      return handle(request);
    },
  });
  return {
    async stop() {
      await server.stop(true);
      await actions.finish();
    },
  };
}
