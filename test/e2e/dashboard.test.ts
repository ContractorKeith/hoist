import { expect, test } from "bun:test";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkBrowserLogs } from "./dashboard-browser";
import {
  csrf,
  dashboardAssetsAndStream,
  dashboardClient,
} from "./dashboard-client";
import { eventually } from "./harness";
import { withSSH } from "./ssh";

const scenario = process.env.HOIST_E2E !== undefined ? test : test.skip;
scenario(
  "dashboard login, masked releases, SSE, rollback and restart through Caddy",
  async () => {
    await withSSH(async (h) => {
      const { appName } = h,
        base = `/apps/${appName}`;
      const child = Bun.spawn(
        [...h.ssh, h.remote, "hoist", "dashboard:set-password"],
        {
          env: h.env,
          stdin: new Response("pw\n"),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toContain("saved");
      await h.control("apps:create", appName);
      const secret = `private-${"q".repeat(279)}`;
      await h.control("config:set", appName, `HOIST_TEST_SECRET=${secret}`);
      await writeFile(
        join(h.source, "Dockerfile"),
        'FROM busybox:1.37.0\nWORKDIR /www\nCOPY index.html .\nCOPY log.cgi /www/cgi-bin/log\nRUN chmod +x /www/cgi-bin/log\nEXPOSE 8080\nCMD ["sh", "-c", "echo ready; exec httpd -f -p 8080 -h /www"]\n',
      );
      await writeFile(
        join(h.source, "log.cgi"),
        '#!/bin/sh\necho request-triggered-$QUERY_STRING > /proc/1/fd/1\nprintf "Content-Type: text/plain\\r\\n\\r\\nokay"\n',
      );
      await h.commit();
      expect((await h.push()).code).toBe(0);
      await writeFile(join(h.source, "index.html"), "second release\n");
      await h.commit();
      expect((await h.push()).code).toBe(0);
      const client = await dashboardClient(h);
      for (const path of [
        "/",
        base,
        `${base}/logs`,
        `${base}/logs/stream`,
        `${base}/status`,
      ])
        expect((await client(path)).status).toBe(303);
      expect((await client("/healthz")).status).toBe(200);
      const login = await client("/login");
      expect(login.status).toBe(200);
      const challenge = login.headers.get("set-cookie")?.split(";")[0] ?? "",
        loginCSRF = csrf(await login.text());
      const signed = await client("/login", challenge, {
        csrf: loginCSRF,
        password: "pw",
      });
      expect(signed.status).toBe(303);
      const setCookie = signed.headers.get("set-cookie") ?? "",
        cookie = setCookie.split(";")[0] ?? "";
      expect(setCookie).toContain("HttpOnly; Secure; SameSite=Strict; Path=/");
      const home = await (await client("/", cookie)).text();
      expect(home).toContain(appName);
      expect(home).toContain("v2 · live");
      const app = await client(base, cookie),
        body = await app.text();
      expect(app.headers.get("Content-Security-Policy")).toContain(
        "default-src 'self'",
      );
      expect(body).toContain("HOIST_TEST_SECRET");
      expect(body).not.toContain(secret);
      expect(body).not.toContain(String(secret.length));
      expect(body).toContain("v1");
      expect(body).toContain("v2");
      const logsPath = `${base}/logs`;
      const streamPath = await dashboardAssetsAndStream(
        client,
        cookie,
        logsPath,
      );
      await checkBrowserLogs(h, logsPath, cookie);
      const token = csrf(body);
      expect(
        (await client(`${base}/rollback`, cookie, { target: "v1" })).status,
      ).toBe(403);
      const server = h.getServer();
      if (!server) throw new Error("Missing server");
      const count = async () =>
        (await readdir(`/proc/${server.pid}/fd`)).length;
      const before = await count();
      for (let i = 0; i < 8; i++) {
        const abort = new AbortController();
        const stream = await client(
          streamPath,
          cookie,
          undefined,
          abort.signal,
        );
        const reader = stream.body?.getReader();
        if (!reader) throw new Error("Missing SSE body");
        let text = new TextDecoder().decode((await reader.read()).value);
        const started = Date.now();
        await (await h.request(undefined, `/cgi-bin/log?marker=${i}`)).text();
        while (!text.includes(`request-triggered-marker=${i}`)) {
          const result = await Promise.race([
            reader.read(),
            Bun.sleep(2000).then(() => {
              throw new Error("SSE marker missed 2 s deadline");
            }),
          ]);
          text += new TextDecoder().decode(result.value);
        }
        expect(Date.now() - started).toBeLessThan(2000);
        abort.abort();
        await reader.cancel().catch(() => {});
      }
      await eventually(async () =>
        expect(await count()).toBeLessThanOrEqual(before + 4),
      );
      console.log(
        `SSE: eight disconnects, fd baseline ${before}, final ${await count()}, marker within 2 s.`,
      );
      const confirm = await (
        await client(`${base}/rollback`, cookie, { csrf: token, target: "v1" })
      ).text();
      expect(confirm).toContain("Confirm rollback");
      const owner = h.store.app(appName);
      if (!owner) throw new Error("Missing app");
      const rows = () => h.store.releases(owner.id);
      expect(rows()).toHaveLength(2);
      await (
        await client(`${base}/rollback`, cookie, {
          csrf: token,
          target: "v1",
          confirmed: "yes",
        })
      ).text();
      await eventually(
        async () =>
          expect(
            await (await client(`${base}/status`, cookie)).text(),
          ).toContain("New release is live"),
        45000,
      );
      expect(await (await h.request()).text()).toBe("hello from hoist\n");
      expect(
        JSON.parse((await h.control("releases", appName, "--json")).stdout).at(
          -1,
        ).number,
      ).toBe(3);
      await (
        await client(`${base}/restart`, cookie, {
          csrf: token,
          confirmed: "yes",
        })
      ).text();
      await eventually(
        async () =>
          expect(
            await (await client(`${base}/status`, cookie)).text(),
          ).toContain("New release is live"),
        45000,
      );
      expect(rows()).toHaveLength(4);
      expect(rows()[3]?.image).toBe(rows()[2]?.image);
      await client("/logout", cookie, { csrf: token });
      expect((await client("/", cookie)).status).toBe(303);
      for (let i = 0; i < 5; i++)
        expect(
          (
            await client("/login", challenge, {
              csrf: loginCSRF,
              password: "wrong",
            })
          ).status,
        ).toBe(401);
      // Caddy must discard an untrusted forwarded address.
      expect(
        (
          await client(
            "/login",
            challenge,
            { csrf: loginCSRF, password: "pw" },
            undefined,
            { "X-Forwarded-For": "192.0.2.1" },
          )
        ).status,
      ).toBe(429);
      await h.stopServe();
      await h.startServe();
      expect(
        (await client("/login", challenge, { csrf: loginCSRF, password: "pw" }))
          .status,
      ).toBe(303);
      expect((await client("/healthz")).status).toBe(200);
    });
  },
  240000,
);
