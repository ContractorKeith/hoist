import type { DockerClient } from "../adapters/interfaces";
import { branchSlug } from "../core/validation";
import { DashboardStore } from "../store/dashboard";
import type { SqliteStore } from "../store/sqlite";
import { type Actions, eligibleReleases } from "./actions";
import { assets } from "./assets";
import { cookie, hashToken, LoginLimit, session, validCSRF } from "./auth";
import { BodyTooLargeError, boundedRequest } from "./body";
import { errorPage, html, redirect, withSecurityHeaders } from "./http";
import { loginHandler } from "./login";
import { logStream } from "./sse";
import {
  appList,
  appPage,
  confirmation,
  escapeHTML,
  page,
  progress,
} from "./templates";

export function dashboard(
  store: SqliteStore,
  docker: DockerClient,
  actions: Actions,
) {
  const db = new DashboardStore(store.db),
    limit = new LoginLimit();
  const handleLogin = loginHandler(db, limit);
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname;
    if (path === "/healthz" && request.method === "GET")
      return new Response("ok\n");
    if (request.method === "GET" && Object.hasOwn(assets, path)) {
      const asset = assets[path];
      if (asset)
        return new Response(asset[0], {
          headers: {
            "Content-Type": asset[1],
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
    }
    if (path === "/login") return handleLogin(request);
    const token = session(db, request);
    if (!token) return redirect("/login");
    if (request.method === "POST") {
      const form = await request.formData();
      if (!validCSRF(token, form.get("csrf")))
        return errorPage("Invalid CSRF token", 403, token);
      if (path === "/logout") {
        db.deleteSession(hashToken(token));
        return redirect("/login", {
          "Set-Cookie": cookie("__Host-hoist_session", "", 0),
        });
      }
      const match = /^\/apps\/([a-z0-9-]+)\/(rollback|restart)$/.exec(path);
      const app = match?.[1] ? store.app(match[1]) : null;
      if (!match || !app) return errorPage("Not found", 404, token);
      const action = match[2] ?? "",
        target = String(form.get("target") ?? ""),
        base = `/apps/${app.name}`;
      if (
        action === "rollback" &&
        !(await eligibleReleases(store, docker, app)).some(
          (row) => `v${row.number}` === target,
        )
      )
        return errorPage("Rollback unavailable", 400, token, base);
      if (form.get("confirmed") !== "yes")
        return html(confirmation(base, action, target, token));
      if (!actions.start(app.name, hashToken(token), action, target))
        return errorPage("An action is already running", 409, token, base);
      return html(
        page(
          "Release progress",
          progress(base, true, "Starting action…"),
          token,
        ),
      );
    }
    if (request.method !== "GET")
      return errorPage("Method not allowed", 405, token);
    if (path === "/") return html(page("Apps", appList(store), token));
    const match =
      /^\/apps\/([a-z0-9-]+)(?:\/(logs(?:\/stream)?|status))?$/.exec(path);
    const app = match?.[1] ? store.app(match[1]) : null;
    if (!app) return errorPage("Not found", 404, token);
    const base = `/apps/${app.name}`;
    if (match?.[2] === "status") {
      const job = actions.status(app.name, hashToken(token));
      return html(
        progress(
          base,
          job?.running ?? false,
          job?.message ?? "No action in progress.",
        ),
      );
    }
    const branch = url.searchParams.get("branch") ?? app.main_branch ?? "main";
    if (match?.[2]?.startsWith("logs")) branchSlug(branch);
    if (match?.[2] === "logs/stream")
      return logStream(
        store,
        docker,
        app.name,
        branch,
        request,
        () => !!session(db, request),
      );
    if (match?.[2] === "logs")
      return html(
        page(
          `${app.name} logs`,
          `<p><a href="${base}">Back to app</a></p><form method="get"><label for="branch">Branch</label><select id="branch" name="branch">${[...new Set([app.main_branch ?? "main", ...store.previews(app.id).map((row) => row.branch)])].map((value) => `<option ${value === branch ? "selected" : ""}>${escapeHTML(value)}</option>`).join("")}</select><button>Tail logs</button></form><p id="log-status" role="status">Following ${escapeHTML(branch)}</p><pre data-log-stream="${base}/logs/stream?branch=${escapeHTML(encodeURIComponent(branch))}" aria-label="Container logs"></pre>`,
          token,
        ),
      );
    return html(
      appPage(
        store,
        app,
        db.configKeys(app.id),
        await eligibleReleases(store, docker, app),
        token,
      ),
    );
  }
  return async (request: Request): Promise<Response> => {
    let response: Response;
    try {
      response = await handle(await boundedRequest(request));
    } catch (error) {
      if (error instanceof BodyTooLargeError)
        response = errorPage("Request body too large", 413);
      else {
        console.error(error);
        response = errorPage("Request could not be completed", 400);
      }
    }
    return withSecurityHeaders(response);
  };
}
