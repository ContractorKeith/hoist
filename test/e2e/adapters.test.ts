import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eventually, withHarness } from "./harness";

// Bun replaces argv with the current test filename, so inspect the original Linux command.
// A bare unit run must never require Docker or download Caddy.
const explicitE2e =
  process.platform === "linux" &&
  readFileSync("/proc/self/cmdline", "utf8")
    .split("\0")
    .some((arg) => arg.includes("test/e2e"));
const scenario = explicitE2e ? test : test.skip;

scenario(
  "real Docker and internal-CA Caddy serve the fixture and tear down cleanly",
  async () => {
    await withHarness(
      async ({ docker, caddy, httpsPort, appPort, labels, tag }) => {
        // Invalid untrusted values must fail before reaching either daemon.
        await expect(
          caddy.upsertRoute("bad/host", `127.0.0.1:${appPort}`),
        ).rejects.toThrow("host name");
        await expect(
          caddy.upsertRoute("hello.test", "remote.test:80"),
        ).rejects.toThrow("upstream");
        await expect(
          docker.listContainers({ "bad/label": "value" }),
        ).rejects.toThrow("label");
        await expect(
          docker.buildImage({ contextDir: "/tmp/../etc", tag, labels }),
        ).rejects.toThrow("path");
        await expect(
          docker.createContainer({
            image: tag,
            labels,
            port: 0,
            publishPort: appPort,
          }),
        ).rejects.toThrow("port");

        const logs = await docker.buildImage({
          contextDir: resolve("test/fixtures/hello"),
          tag,
          labels,
        });
        const buildLog = await new Response(logs).text();
        expect(buildLog.length).toBeGreaterThan(0);
        expect(await docker.listImages(labels)).toHaveLength(1);
        const id = await docker.createContainer({
          image: tag,
          labels,
          port: 8080,
          publishPort: appPort,
        });
        await docker.startContainer(id);
        expect(
          (await docker.listContainers(labels)).map(
            (container) => container.id,
          ),
        ).toContain(id);
        await eventually(async () => {
          const response = await fetch(`http://127.0.0.1:${appPort}`, {
            signal: AbortSignal.timeout(2000),
          });
          expect(await response.text()).toBe("hello from hoist\n");
        });
        await caddy.upsertRoute("hello.test", `127.0.0.1:${appPort}`);
        const request = () =>
          fetch(`https://127.0.0.1:${httpsPort}/`, {
            headers: { Host: "hello.test" },
            tls: { rejectUnauthorized: false, serverName: "hello.test" },
            signal: AbortSignal.timeout(2000),
          });
        await eventually(async () => {
          const response = await request();
          expect(response.status).toBe(200);
          expect(await response.text()).toBe("hello from hoist\n");
        });
        await caddy.upsertRoute("hello.test", `127.0.0.1:${appPort}`);
        expect(await (await request()).text()).toBe("hello from hoist\n");
        await caddy.removeRoute("hello.test");
        expect(await (await request()).text()).not.toContain(
          "hello from hoist",
        );
        const containerLog = await new Response(
          await docker.containerLogs(id),
        ).text();
        expect(containerLog).toContain("httpd");
        await docker.stopContainer(id);
        await docker.removeContainer(id);
        await docker.removeImage(tag);
      },
    );
  },
  180000,
);
