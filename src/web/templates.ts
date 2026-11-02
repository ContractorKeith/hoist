import { releaseHost } from "../core/previews";
import type { App, Release, Store } from "../store/interface";
import { csrfToken } from "./auth";

export const escapeHTML = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] as string,
  );
export const csrfField = (token: string) =>
  `<input type="hidden" name="csrf" value="${csrfToken(token)}">`;
export function page(title: string, body: string, token?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="htmx-config" content='{"allowEval":false,"includeIndicatorStyles":false,"selfRequestsOnly":true}'><title>${escapeHTML(title)} · hoist</title><link rel="stylesheet" href="/static/style.css"><script src="/static/htmx.min.js" defer></script><script src="/static/dashboard.js" defer></script></head><body><a class="skip" href="#main">Skip to content</a><header><a class="brand" href="/">hoist</a><span>One server. Your apps.</span>${token ? `<form method="post" action="/logout">${csrfField(token)}<button class="secondary">Log out</button></form>` : ""}</header><main id="main"><h1>${escapeHTML(title)}</h1>${body}</main><footer>Manage apps and config with the hoist CLI.</footer></body></html>`;
}
export function login(token: string, message = ""): string {
  return page(
    "Welcome back",
    `<section class="login"><p>Sign in to your server.</p>${message ? `<p role="alert">${escapeHTML(message)}</p>` : ""}<form method="post" action="/login">${csrfField(token)}<label for="password">Owner password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"><button>Sign in</button></form></section>`,
  );
}
export function appList(store: Store): string {
  return `<div class="cards">${
    store
      .apps()
      .map((app) => {
        const live = store
          .releases(app.id)
          .findLast(
            (row) =>
              row.branch === (app.main_branch ?? "main") &&
              row.status === "live",
          );
        return `<article><h2><a href="/apps/${escapeHTML(app.name)}">${escapeHTML(app.name)}</a></h2><p>${escapeHTML(app.domain)}</p><p class="status">${live ? `v${live.number} · live` : "No live release"}</p></article>`;
      })
      .join("") ||
    "<p>No apps yet. Run <code>hoist apps:create &lt;name&gt;</code> to get started.</p>"
  }</div>`;
}
export function appPage(
  store: Store,
  app: App,
  keys: string[],
  eligible: Release[],
  token: string,
): string {
  const base = `/apps/${app.name}`;
  return page(
    app.name,
    `<p>${escapeHTML(app.domain)} · <a href="${base}/logs">Live logs</a></p><section><h2>Releases</h2><div class="table-scroll"><table><thead><tr><th>Release</th><th>Branch</th><th>Status</th><th>Commit</th><th>Created</th></tr></thead><tbody>${store
      .releases(app.id)
      .toReversed()
      .map(
        (row) =>
          `<tr><td>v${row.number}</td><td>${escapeHTML(row.branch)}</td><td>${escapeHTML(row.status)}</td><td><code>${escapeHTML(row.git_sha.slice(0, 12))}</code></td><td>${escapeHTML(row.created_at)}</td></tr>`,
      )
      .join("")}</tbody></table></div></section><section><h2>Previews</h2><ul>${
      store
        .previews(app.id)
        .map(
          (row) =>
            `<li>${escapeHTML(row.branch)} · ${escapeHTML(releaseHost(app, row.branch))}</li>`,
        )
        .join("") || "<li>No previews</li>"
    }</ul></section><section><h2>Config</h2><p>Values stay on the server.</p><dl>${keys.map((key) => `<dt><code>${escapeHTML(key)}</code></dt><dd>••••••••</dd>`).join("") || "<dt>No config keys</dt>"}</dl></section><section><h2>Actions</h2><p>Each action creates a new release on ${escapeHTML(app.main_branch ?? "main")}.</p><form method="post" action="${base}/rollback">${csrfField(token)}<label for="target">Roll back to</label><select id="target" name="target" required ${eligible.length ? "" : "disabled"}>${eligible.map((row) => `<option value="v${row.number}">v${row.number} · ${escapeHTML(row.git_sha.slice(0, 12))}</option>`).join("")}</select><button ${eligible.length ? "" : "disabled"}>Review rollback</button></form><form method="post" action="${base}/restart">${csrfField(token)}<button class="secondary">Review restart</button></form></section>`,
    token,
  );
}
export function confirmation(
  base: string,
  action: string,
  target: string,
  token: string,
): string {
  return page(
    `Confirm ${action}`,
    `<p>${escapeHTML(action === "rollback" ? `Roll back to ${target}` : "Restart the live image with current config")}? Traffic moves after the health check passes.</p><form method="post" action="${base}/${action}">${csrfField(token)}<input type="hidden" name="target" value="${escapeHTML(target)}"><input type="hidden" name="confirmed" value="yes"><button>Confirm ${escapeHTML(action)}</button><a href="${base}">Cancel</a></form>`,
    token,
  );
}
export function progress(
  base: string,
  running: boolean,
  message: string,
): string {
  return `<section id="progress" role="status" ${running ? `hx-get="${base}/status" hx-trigger="every 1s" hx-swap="outerHTML"` : ""}><p>${escapeHTML(message)}</p>${running ? "" : `<a href="${base}">View app</a>`}</section>`;
}
