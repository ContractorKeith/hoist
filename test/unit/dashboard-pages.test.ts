import { expect, test } from "bun:test";
import { reserveRelease } from "../../src/core/build";
import { createSession, csrfToken } from "../../src/web/auth";
import { request, setup } from "./dashboard-support";

test("all pages require a session; health and login are public; headers apply everywhere", async () => {
  const h = await setup();
  try {
    for (const path of [
      "/",
      "/apps/hello",
      "/apps/hello/logs",
      "/apps/hello/logs/stream",
      "/apps/hello/status",
      "/unknown",
    ]) {
      const response = await h.handle(request(path));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
      expect(response.headers.get("Content-Security-Policy")).toContain(
        "script-src 'self'",
      );
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
    expect((await h.handle(request("/healthz"))).status).toBe(200);
    expect((await h.handle(request("/login"))).status).toBe(200);
  } finally {
    await h.close();
  }
});
test("templates escape untrusted branches and show only config names, releases and previews", async () => {
  const h = await setup();
  try {
    const app = h.store.createApp("hello", "hello.test", "/");
    h.store.setConfig(app.id, "SECRET", "never-render-this-or-its-length");
    const row = reserveRelease(h.store, app, "<img>", "a".repeat(40));
    h.store.completeRelease(row.id);
    const token = createSession(h.db),
      cookie = `hoist_session=${token}`;
    const response = await h.handle(request("/apps/hello", cookie)),
      body = await response.text();
    expect(body).toContain("SECRET");
    expect(body).toContain("••••••••");
    expect(body).not.toContain("never-render-this");
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;img");
    expect(body).toContain("a".repeat(12));
    expect(body).not.toContain("config:set");
    expect(
      (
        await h.handle(
          request("/apps/hello/rollback", cookie, { target: "v1" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await h.handle(
          request("/apps/hello/restart", cookie, { csrf: csrfToken("other") }),
        )
      ).status,
    ).toBe(403);
  } finally {
    await h.close();
  }
});
test("actions require confirmation, poll progress, serialize and report failure without reflecting secrets", async () => {
  let finish: (() => void) | undefined;
  const calls: string[][] = [];
  const h = await setup(async (args) => {
    calls.push(args);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  try {
    h.store.createApp("hello", "hello.test", "/");
    const token = createSession(h.db),
      cookie = `hoist_session=${token}`,
      form = { csrf: csrfToken(token) };
    expect(
      await (
        await h.handle(request("/apps/hello/restart", cookie, form))
      ).text(),
    ).toContain("Confirm restart");
    expect(calls).toEqual([]);
    expect(
      await (
        await h.handle(
          request("/apps/hello/restart", cookie, { ...form, confirmed: "yes" }),
        )
      ).text(),
    ).toContain('hx-trigger="every 1s"');
    expect(calls).toEqual([["restart", "hello"]]);
    expect(
      (
        await h.handle(
          request("/apps/hello/restart", cookie, { ...form, confirmed: "yes" }),
        )
      ).status,
    ).toBe(409);
    finish?.();
    await h.actions.finish();
    expect(
      await (await h.handle(request("/apps/hello/status", cookie))).text(),
    ).toContain("New release is live");
  } finally {
    finish?.();
    await h.close();
  }
});

test("failed actions show a safe error sentence and never reflect the thrown value", async () => {
  const h = await setup(async () => {
    throw new Error("private-config-value");
  });
  const original = console.error;
  console.error = () => {};
  try {
    h.store.createApp("hello", "hello.test", "/");
    const token = createSession(h.db),
      cookie = `hoist_session=${token}`;
    await h.handle(
      request("/apps/hello/restart", cookie, {
        csrf: csrfToken(token),
        confirmed: "yes",
      }),
    );
    await h.actions.finish();
    const body = await (
      await h.handle(request("/apps/hello/status", cookie))
    ).text();
    expect(body).toContain("Action failed.");
    expect(body).not.toContain("private-config-value");
    expect(body).not.toContain("hx-trigger");
  } finally {
    console.error = original;
    await h.close();
  }
});
