import type { DockerClient } from "../adapters/interfaces";
import { branchSlug } from "../core/validation";
import { DashboardStore } from "../store/dashboard";
import type { SqliteStore } from "../store/sqlite";
import { type Actions, eligibleReleases } from "./actions";
import { assets } from "./assets";
import { cookie, hashToken, LoginLimit, session, validCSRF } from "./auth";
import { html, redirect, securityHeaders } from "./http";
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
          headers: { "Content-Type": asset[1] },
        });
    }
    if (path === "/login") return handleLogin(request);
    const token = session(db, request);
    if (!token) return redirect("/login");
    if (request.method === "POST") {
      const form = await request.formData();
      if (!validCSRF(token, form.get("csrf")))
        return new Response("Invalid CSRF token", { status: 403 });
      if (path === "/logout") {
        db.deleteSession(hashToken(token));
        return redirect("/login", {
          "Set-Cookie": cookie("hoist_session", "", 0),
        });
      }
      const match = /^\/apps\/([a-z0-9-]+)\/(rollback|restart)$/.exec(path);
      const app = match?.[1] ? store.app(match[1]) : null;
      if (!match || !app) return new Response("Not found", { status: 404 });
      const action = match[2] ?? "",
        target = String(form.get("target") ?? ""),
        base = `/apps/${app.name}`;
      if (
        action === "rollback" &&
        !(await eligibleReleases(store, docker, app)).some(
          (row) => `v${row.number}` === target,
        )
      )
        return html(
          page(
            "Rollback unavailable",
            "<p>Choose an available release from the app page.</p>",
            token,
          ),
          400,
        );
      if (form.get("confirmed") !== "yes")
        return html(confirmation(base, action, target, token));
      if (!actions.start(app.name, hashToken(token), action, target))
        return new Response("An action is already running", { status: 409 });
      return html(
        page(
          "Release progress",
          progress(base, true, "Starting action…"),
          token,
        ),
      );
    }
    if (request.method !== "GET")
      return new Response("Method not allowed", { status: 405 });
    if (path === "/") return html(page("Apps", appList(store), token));
    const match =
      /^\/apps\/([a-z0-9-]+)(?:\/(logs(?:\/stream)?|status))?$/.exec(path);
    const app = match?.[1] ? store.app(match[1]) : null;
    if (!app) return new Response("Not found", { status: 404 });
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
      response = await handle(request);
    } catch (error) {
      console.error(error);
      response = new Response("Request could not be completed", {
        status: 400,
      });
    }
    for (const [key, value] of Object.entries(securityHeaders))
      response.headers.set(key, value);
    return response;
  };
}
