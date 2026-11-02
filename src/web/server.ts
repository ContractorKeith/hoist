import type { DockerClient } from "../adapters/interfaces";
import { hostName, port } from "../adapters/validation";
import { releasesCommand } from "../cli/releases";
import { dashboardHost } from "../core/caddy-config";
import type { SqliteStore } from "../store/sqlite";
import { Actions } from "./actions";
import { errorPage, withSecurityHeaders } from "./http";
import { dashboard } from "./router";

export function allowRequest(
  peer: string | undefined,
  headers: Headers,
): boolean {
  return (
    (peer === "127.0.0.1" || peer === "::1") &&
    headers.get("x-forwarded-proto") === "https"
  );
}

export function dashboardRoute() {
  const host = dashboardHost();
  hostName(host);
  const dashboardPort = Number(process.env.HOIST_DASHBOARD_PORT ?? 8700);
  port(dashboardPort);
  return { host, upstream: `127.0.0.1:${dashboardPort}`, port: dashboardPort };
}
export function startDashboard(
  root: string,
  store: SqliteStore,
  docker: DockerClient,
  options: { signal?: AbortSignal; port?: number } = {},
) {
  const route = dashboardRoute();
  const actions = new Actions(
    (args, signal) => releasesCommand(root, store, args, signal),
    options.signal,
  );
  const handle = dashboard(store, docker, actions);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? route.port,
    idleTimeout: 0,
    // The handler owns the bounded read so even early 413 responses have security headers.
    maxRequestBodySize: Infinity,
    fetch(request, server) {
      const peer = server.requestIP(request)?.address;
      if (!allowRequest(peer, request.headers)) {
        const message =
          peer === "127.0.0.1" || peer === "::1"
            ? "Caddy HTTPS required"
            : "Loopback required";
        return withSecurityHeaders(errorPage(message, 403));
      }
      return handle(request);
    },
  });
  return {
    server,
    async stop() {
      await server.stop(true);
      await actions.finish();
    },
  };
}
