import { expect, test } from "bun:test";
import { csrf, request, setup } from "./dashboard-support";

test("login throttles the last validated forwarded address, regardless of earlier entries", async () => {
  const h = await setup();
  try {
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
    for (let i = 0; i < 5; i++)
      expect(
        (
          await h.handle(
            request(
              "/login",
              cookie,
              { csrf: token, password: "wrong" },
              `192.0.2.${i + 1}, 127.0.0.1 `,
            ),
          )
        ).status,
      ).toBe(401);
    expect(
      (
        await h.handle(
          request(
            "/login",
            cookie,
            { csrf: token, password: "pw" },
            "198.51.100.9, 127.0.0.1",
          ),
        )
      ).status,
    ).toBe(429);
    expect(
      (
        await h.handle(
          request(
            "/login",
            cookie,
            { csrf: token, password: "pw" },
            "198.51.100.9, 127.0.0.2",
          ),
        )
      ).status,
    ).toBe(303);
    expect(
      (
        await h.handle(
          request(
            "/login",
            cookie,
            { csrf: token, password: "pw" },
            "127.0.0.1, bogus",
          ),
        )
      ).status,
    ).toBe(400);
  } finally {
    await h.close();
  }
});
