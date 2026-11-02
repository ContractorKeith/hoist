import { expect, test } from "bun:test";
import {
  createSession,
  hashToken,
  LoginLimit,
  session,
  verifyPassword,
} from "../../src/web/auth";
import { loginHandler } from "../../src/web/login";
import { csrf, request, setup } from "./dashboard-support";

const cheapHash = (password: string) =>
  Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 1024,
    timeCost: 1,
  });
test("a password reset racing verification cannot issue an old-password session", async () => {
  const h = await setup();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: (() => void) | undefined;
  const verifying = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    h.db.savePassword(await cheapHash("old"));
    const handler = loginHandler(
      h.db,
      new LoginLimit(),
      async (password, hash) => {
        entered?.();
        await gate;
        return verifyPassword(password, hash);
      },
    );
    const login = await handler(request("/login"));
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "",
      token = csrf(await login.text());
    const pending = handler(
      request("/login", cookie, { csrf: token, password: "old" }),
    );
    await verifying;
    h.db.savePassword(await cheapHash("new"));
    release?.();
    const response = await pending;
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Password changed; sign in again");
    expect(
      h.store.db.query("SELECT count(*) AS n FROM sessions").get(),
    ).toEqual({ n: 0 });
    expect(response.headers.has("set-cookie")).toBe(false);
  } finally {
    release?.();
    await h.close();
  }
});
test("reset atomically changes hash/version and revokes sessions; stale versions fail closed", async () => {
  const h = await setup();
  try {
    h.db.savePassword(await cheapHash("old"));
    const token = createSession(h.db),
      old = h.store.db.query("SELECT * FROM sessions").get() as {
        token_hash: string;
        expires_at: string;
        password_version: string;
      };
    expect(old.password_version).toBeTruthy();
    const oldVersion = h.db.credentials()?.version;
    h.db.savePassword(await cheapHash("new"));
    expect(h.db.credentials()?.version).not.toBe(oldVersion);
    expect(
      session(h.db, request("/", `__Host-hoist_session=${token}`)),
    ).toBeNull();
    h.store.db.run(
      "INSERT INTO sessions(token_hash, expires_at, password_version) VALUES (?, ?, ?)",
      [old.token_hash, old.expires_at, old.password_version],
    );
    expect(
      session(h.db, request("/", `__Host-hoist_session=${token}`)),
    ).toBeNull();
    expect(h.store.db.query("SELECT * FROM sessions").all()).toEqual([]);
    const current = createSession(h.db),
      before = h.db.credentials();
    h.store.db.exec(
      "CREATE TRIGGER refuse_session_revoke BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'test revoke failure'); END",
    );
    expect(() => h.db.savePassword("replacement")).toThrow(
      "test revoke failure",
    );
    expect(h.db.credentials()).toEqual(before);
    expect(session(h.db, request("/", `__Host-hoist_session=${current}`))).toBe(
      current,
    );
  } finally {
    await h.close();
  }
});
test("invalid or expired timestamps are rejected and removed", async () => {
  const h = await setup();
  try {
    h.db.savePassword(await cheapHash("pw"));
    for (const expires of ["garbage", "2000-01-01T00:00:00.000Z"]) {
      const token = createSession(h.db);
      h.store.db.run(
        "UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
        [expires, hashToken(token)],
      );
      expect(
        session(h.db, request("/", `__Host-hoist_session=${token}`)),
      ).toBeNull();
      expect(h.store.db.query("SELECT * FROM sessions").all()).toEqual([]);
    }
  } finally {
    await h.close();
  }
});
test("removing the owner password invalidates sessions and explains setup on login", async () => {
  const h = await setup();
  try {
    h.db.savePassword(await cheapHash("pw"));
    const token = createSession(h.db);
    h.store.db.run("DELETE FROM settings WHERE key = 'owner_password'");
    expect(
      (
        await h.handle(request("/", `__Host-hoist_session=${token}`))
      ).headers.get("location"),
    ).toBe("/login");
    expect(await (await h.handle(request("/login"))).text()).toContain(
      "No owner password is set; run hoist dashboard:set-password",
    );
  } finally {
    await h.close();
  }
});
