import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eventually } from "./harness";
import { command, withSSH } from "./ssh";

const scenario = process.env.HOIST_E2E !== undefined ? test : test.skip;
scenario(
  "failed build log readable after push",
  async () => {
    await withSSH(async (h) => {
      await h.control("apps:create", "hello");
      expect((await h.push()).code).toBe(0);
      const runtime = await h.control("logs", "hello");
      expect(runtime.stdout).toContain("httpd listening on 8080");
      expect(runtime.stdout).not.toContain("\r");
      const one = await h.control("logs", "hello", "-n", "1");
      expect(one.stdout.trim().split("\n")).toHaveLength(1);
      const saved = await h.control("logs", "hello", "--release", "v1");
      for (const text of [
        "Starting new container",
        "Health check GET /",
        "Health check passed (HTTP 2xx)",
        "Swapping Caddy upstream",
        "Live: https://",
      ])
        expect(saved.stdout).toContain(text);
      expect(saved.stdout).not.toContain('{"stream":');
      await writeFile(
        join(h.source, "Dockerfile"),
        "FROM busybox:1.37.0\nRUN hoist_missing_command\n",
      );
      await h.commit();
      expect((await h.push()).code).not.toBe(0);
      const failed = await h.control("logs", "hello", "--release", "v2");
      expect(failed.stdout).toContain("hoist_missing_command");
      expect(failed.stdout).toContain("Docker build:");
      const missing = await command([
        ...h.ssh,
        h.remote,
        "hoist",
        "logs",
        "hello",
        "--release",
        "v999",
      ]);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("release v999");
      const app = h.store.app("hello");
      expect(app && h.store.releases(app.id)[0]?.status).toBe("live");
    });
  },
  120000,
);

scenario(
  "follow ends on cutover",
  async () => {
    await withSSH(async (h) => {
      await h.control("apps:create", "hello");
      // CGI writes a unique request marker to the container TTY; health checks stay quiet.
      await writeFile(
        join(h.source, "Dockerfile"),
        'FROM busybox:1.37.0\nWORKDIR /www\nCOPY index.html .\nCOPY log.cgi /www/cgi-bin/log\nRUN chmod +x /www/cgi-bin/log\nEXPOSE 8080\nCMD ["sh", "-c", "echo first; echo second; echo ready; exec httpd -f -p 8080 -h /www"]\n',
      );
      await writeFile(
        join(h.source, "log.cgi"),
        '#!/bin/sh\necho request-triggered > /proc/1/fd/1\nprintf "Content-Type: text/plain\\r\\n\\r\\nokay"\n',
      );
      await h.commit();
      expect((await h.push()).code).toBe(0);
      expect((await h.control("logs", "hello", "-n", "1")).stdout).toBe(
        "ready\n",
      );
      expect((await h.control("logs", "hello", "-n", "2")).stdout).toBe(
        "second\nready\n",
      );
      const child = Bun.spawn(
        [...h.ssh, h.remote, "hoist", "logs", "hello", "-f"],
        { stdout: "pipe", stderr: "pipe" },
      );
      let output = "";
      const consume = (async () => {
        for await (const chunk of child.stdout)
          output += new TextDecoder().decode(chunk);
      })();
      const errors = new Response(child.stderr).text();
      try {
        await eventually(async () => {
          expect(output).toContain("ready");
        });
        const start = output.length;
        const requestedAt = Date.now();
        const app = h.store.app("hello");
        const id = app && h.store.releases(app.id)[0]?.container_id;
        if (!id) throw new Error("Missing live container");
        const info = await h.docker.inspectContainer(id);
        await fetch(`http://127.0.0.1:${info?.port}/cgi-bin/log`);
        await eventually(async () => {
          expect(output.slice(start)).toContain("request-triggered");
        }, 1900);
        expect(Date.now() - requestedAt).toBeLessThan(2000);
        await writeFile(join(h.source, "index.html"), "second\n");
        await h.commit();
        expect((await h.push()).code).toBe(0);
        await eventually(async () => {
          expect(child.exitCode).toBe(0);
        }, 5000);
        await consume;
        expect(output).toContain("--- release v2 took over ---");
        expect(output).not.toContain("\r");
        expect(
          (await h.control("logs", "hello", "--release", "v2")).stdout,
        ).toContain("Stopping previous container");
        const interrupted = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, "../../src/cli/index.ts"),
            "logs",
            "hello",
            "-f",
          ],
          { env: h.env, stdout: "pipe", stderr: "pipe" },
        );
        const reader = interrupted.stdout.getReader();
        const stderr = new Response(interrupted.stderr).text();
        try {
          expect((await reader.read()).done).toBe(false);
          interrupted.kill("SIGINT");
          await eventually(async () => {
            expect(interrupted.exitCode).toBe(0);
          }, 2000);
        } finally {
          if (interrupted.exitCode === null) interrupted.kill("SIGKILL");
          await interrupted.exited;
          await reader.cancel();
          reader.releaseLock();
          await stderr;
        }
        const rollback = await h.control("rollback", "hello", "v1");
        expect(rollback.stdout).toContain("Live: https://");
        const saved = await h.control("logs", "hello", "--release", "v3");
        for (const step of [
          "Starting new container",
          "Health check passed",
          "Swapping Caddy upstream",
          "Stopping previous container",
          "Live: https://",
        ])
          expect(saved.stdout).toContain(step);
        expect(saved.stdout).not.toContain('{"stream":');
        expect(await (await h.request()).text()).toBe("hello from hoist\n");
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
        await consume;
        await errors;
      }
    });
  },
  120000,
);
