import { expect, test } from "bun:test";
import {
  createSession,
  csrfToken,
  hashPassword,
  hashToken,
  LoginLimit,
  session,
  validCSRF,
  verifyPassword,
} from "../../src/web/auth";
import { csrf, request, setup } from "./dashboard-support";

test("password hashes use Argon2id and fresh salts", async () => {
  const hash = await hashPassword("pw");
  expect(hash).toStartWith("$argon2id$");
  expect(await hashPassword("pw")).not.toBe(hash);
});
test("password verification accepts only the supplied password", async () => {
  const hash = await Bun.password.hash("pw", {
    algorithm: "argon2id",
    memoryCost: 1024,
    timeCost: 1,
  });
  expect(await verifyPassword("pw", hash)).toBe(true);
  expect(await verifyPassword("wrong", hash)).toBe(false);
});
test("sessions persist only SHA-256, expire after seven days, revoke on logout and password change", async () => {
  const h = await setup();
  try {
    const now = Date.now(),
      token = createSession(h.db, now),
      cookie = `__Host-hoist_session=${token}`;
    expect(h.store.db.query("SELECT token_hash FROM sessions").get()).toEqual({
      token_hash: hashToken(token),
    });
    expect(session(h.db, request("/", cookie), now)).toBe(token);
    expect(session(h.db, request("/", cookie), now + 7 * 86400000)).toBeNull();
    expect((await h.handle(request("/logout", cookie, {}))).status).toBe(403);
    const response = await h.handle(
      request("/logout", cookie, { csrf: csrfToken(token) }),
    );
    expect(response.status).toBe(303);
    expect(session(h.db, request("/", cookie))).toBeNull();
    const other = createSession(h.db);
    h.db.savePassword(await hashPassword("changed"));
    expect(
      session(h.db, request("/", `__Host-hoist_session=${other}`)),
    ).toBeNull();
  } finally {
    await h.close();
  }
});
test("five failures block just that client for fifteen minutes; CSRF is per session", () => {
  const limit = new LoginLimit();
  for (let i = 0; i < 5; i++) {
    expect(limit.blocked("a", 100)).toBe(false);
    limit.fail("a", 100);
  }
  expect(limit.blocked("a", 101)).toBe(true);
  expect(limit.blocked("b", 101)).toBe(false);
  expect(limit.blocked("a", 900100)).toBe(false);
  expect(validCSRF("a", csrfToken("a"))).toBe(true);
  expect(validCSRF("b", csrfToken("a"))).toBe(false);
  expect(validCSRF("a", "é".repeat(64))).toBe(false);
});
test("login refuses missing CSRF, wrong password, and a sixth attempt; success sets secure cookie", async () => {
  const h = await setup();
  try {
    // Route tests use a cheaper real Argon2id fixture; hashing policy is tested above.
    h.db.savePassword(
      await Bun.password.hash("pw", {
        algorithm: "argon2id",
        memoryCost: 1024,
        timeCost: 1,
      }),
    );
    const login = await h.handle(request("/login"));
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const token = csrf(await login.text());
    expect(
      (await h.handle(request("/login", cookie, { password: "pw" }))).status,
    ).toBe(403);
    for (let i = 0; i < 5; i++)
      expect(
        (
          await h.handle(
            request("/login", cookie, { csrf: token, password: "wrong" }),
          )
        ).status,
      ).toBe(401);
    expect(
      (
        await h.handle(
          request("/login", cookie, { csrf: token, password: "pw" }),
        )
      ).status,
    ).toBe(429);
    const success = await h.handle(
      request("/login", cookie, { csrf: token, password: "pw" }, "127.0.0.2"),
    );
    expect(success.status).toBe(303);
    expect(success.headers.get("set-cookie")).toContain(
      "HttpOnly; Secure; SameSite=Strict; Path=/",
    );
    expect(
      h.store.db.query("SELECT count(*) AS n FROM sessions").get(),
    ).toEqual({ n: 1 });
  } finally {
    await h.close();
  }
});

test("reloading login in another request preserves the visible form's CSRF challenge", async () => {
  const h = await setup();
  try {
    const first = await h.handle(request("/login"));
    const firstCookie = first.headers.get("set-cookie")?.split(";")[0] ?? "";
    const visible = csrf(await first.text());
    const repeated = await h.handle(request("/login", firstCookie));
    const newCookie = repeated.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(csrf(await repeated.text())).toBe(visible);
    expect(newCookie).toBe(firstCookie);
  } finally {
    await h.close();
  }
});
