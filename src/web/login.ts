import { isIP } from "node:net";
import type { DashboardStore } from "../store/dashboard";
import {
  cookie,
  createSession,
  type LoginLimit,
  randomToken,
  readCookie,
  validCSRF,
  verifyPassword,
} from "./auth";
import { errorPage, html, redirect } from "./http";
import { login } from "./templates";
export function loginHandler(db: DashboardStore, limit: LoginLimit) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "GET") {
      // Keep open forms valid when another tab or an asset redirect requests login.
      const token = readCookie(request, "__Host-hoist_login") || randomToken();
      return html(login(token), 200, {
        "Set-Cookie": cookie("__Host-hoist_login", token, 900),
      });
    }
    if (request.method !== "POST")
      return errorPage("Method not allowed", 405, undefined, "/login");
    const form = await request.formData(),
      challenge = readCookie(request, "__Host-hoist_login");
    if (!challenge || !validCSRF(challenge, form.get("csrf")))
      return errorPage("Invalid CSRF token", 403, undefined, "/login");
    const ip =
      (request.headers.get("x-forwarded-for") ?? "")
        .split(",")
        .at(-1)
        ?.trim() ?? "";
    if (!isIP(ip))
      return errorPage(
        "Caddy client address required",
        400,
        undefined,
        "/login",
      );
    if (limit.blocked(ip))
      return html(
        login(challenge, "Too many attempts. Try again in 15 minutes."),
        429,
      );
    const password = form.get("password"),
      hash = db.password();
    // Count before awaiting Argon2 so concurrent requests share the same five-attempt budget.
    limit.fail(ip);
    if (
      typeof password !== "string" ||
      password.length > 1024 ||
      !hash ||
      !(await verifyPassword(password, hash))
    )
      return html(login(challenge, "Password refused."), 401);
    limit.clear(ip);
    return redirect("/", {
      "Set-Cookie": cookie(
        "__Host-hoist_session",
        createSession(db),
        7 * 86400,
      ),
    });
  };
}
