import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Docker } from "../../src/adapters/docker";
import { eventually, withHarness } from "./harness";

const enabled = process.env.HOIST_E2E !== undefined;
const scenario = enabled ? test : test.skip;

scenario(
  "real Docker and internal-CA Caddy serve the fixture and tear down cleanly",
  async () => {
    if (process.platform !== "linux") throw new Error("E2e requires Linux");
    await withHarness(
      async ({ docker, caddy, httpsPort, appPort, labels, tag, ca }) => {
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

        await expect(
          caddy.upsertRoute("127.0.0.1", `127.0.0.1:${appPort}`),
        ).rejects.toThrow("host name");
        expect(() => new Docker("tcp://127.0.0.1:2375")).toThrow(
          "only unix sockets",
        );
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
            tls: { ca, serverName: "hello.test" },
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
