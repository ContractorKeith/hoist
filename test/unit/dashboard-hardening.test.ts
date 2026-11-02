import { expect, test } from "bun:test";
import { createSession, csrfToken, readCookie } from "../../src/web/auth";
import { request, setup } from "./dashboard-support";

test("framing and navigation restrictions apply to pages, errors and static assets", async () => {
  const h = await setup();
  try {
    const cookie = `__Host-hoist_session=${createSession(h.db)}`;
    for (const [path, status] of [
      ["/", 200],
      ["/missing", 404],
      ["/static/style.css", 200],
    ] as const) {
      const response = await h.handle(request(path, cookie));
      expect(response.status).toBe(status);
      const csp = response.headers.get("Content-Security-Policy");
      for (const policy of [
        "frame-ancestors 'none'",
        "form-action 'self'",
        "base-uri 'none'",
      ])
        expect(csp).toContain(policy);
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Cache-Control")).toBe(
        path.startsWith("/static/")
          ? "public, max-age=31536000, immutable"
          : "no-store",
      );
    }
  } finally {
    await h.close();
  }
});
test("host-only cookie names ignore a sibling's earlier non-prefixed cookie", () => {
  const genuine = "a".repeat(64),
    shadow = "b".repeat(64);
  const req = request(
    "/",
    `hoist_session=${shadow}; __Host-hoist_session=${genuine}; hoist_login=${shadow}; __Host-hoist_login=${genuine}`,
  );
  expect(readCookie(req)).toBe(genuine);
  expect(readCookie(req, "__Host-hoist_login")).toBe(genuine);
  expect(readCookie(request("/", `hoist_session=${shadow}`))).toBe("");
});
test("error responses retain status codes and render a page with a way back", async () => {
  let finish: (() => void) | undefined;
  const h = await setup(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    h.store.createApp("hello", "hello.test", "/");
    const token = createSession(h.db),
      cookie = `__Host-hoist_session=${token}`,
      form = { csrf: csrfToken(token) };
    await h.handle(
      request("/apps/hello/restart", cookie, { ...form, confirmed: "yes" }),
    );
    const method = new Request("https://hoist.test/", {
      method: "PUT",
      headers: { cookie },
    });
    const responses = [
      await h.handle(method),
      await h.handle(request("/missing", cookie)),
      await h.handle(
        request("/apps/hello/restart", cookie, { ...form, confirmed: "yes" }),
      ),
      await h.handle(
        request("/apps/hello/rollback", cookie, { ...form, target: "v99" }),
      ),
      await h.handle(request("/apps/hello/restart", cookie, {})),
    ];
    for (const [index, status] of [405, 404, 409, 400, 403].entries()) {
      const response = responses[index];
      expect(response?.status).toBe(status);
      const body = await response?.text();
      expect(body).toContain("<!doctype html>");
      expect(body).toContain('<a href="/');
      expect(body).toContain("Back");
    }
  } finally {
    finish?.();
    await h.close();
  }
});
