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
      // Busybox httpd's verbose access log goes to the container's merged TTY output.
      await writeFile(
        join(h.source, "Dockerfile"),
        'FROM busybox:1.37.0\nWORKDIR /www\nCOPY index.html .\nEXPOSE 8080\nCMD ["sh", "-c", "echo ready; exec httpd -f -vv -p 8080 -h /www"]\n',
      );
      await h.commit();
      expect((await h.push()).code).toBe(0);
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
        await h.request();
        await eventually(async () => {
          expect(output.length).toBeGreaterThan(start);
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
