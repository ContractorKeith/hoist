import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
          docker.buildImage(
            { contextDir: "/tmp/../etc", tag, labels },
            AbortSignal.timeout(120_000),
          ),
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
        const context = await mkdtemp(join(tmpdir(), "hoist-tcp-"));
        await cp(resolve(import.meta.dir, "../fixtures/hello"), context, {
          recursive: true,
        });
        await writeFile(
          join(context, "Dockerfile"),
          (await readFile(join(context, "Dockerfile"), "utf8")).replace(
            "EXPOSE 8080",
            "EXPOSE 8080 9999/udp",
          ),
        );
        try {
          const logs = await docker.buildImage(
            {
              contextDir: context,
              tag,
              labels,
            },
            AbortSignal.timeout(120_000),
          );
          const buildLog = await new Response(logs).text();
          expect(buildLog.length).toBeGreaterThan(0);
        } finally {
          await rm(context, { recursive: true, force: true });
        }
        expect(await docker.imagePorts(tag)).toEqual([8080]);
        expect(await docker.listImages(labels)).toHaveLength(1);
        const id = await docker.createContainer({
          image: tag,
          labels,
          port: 8080,
          publishPort: appPort,
        });
        await docker.startContainer(id);
        await expect(docker.inspectContainer(id, 9999)).rejects.toThrow(
          "Invalid port",
        );
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
        // Only TCP exposures count, and inspection must select the requested binding.
        const mixed = await docker.createContainer({
          image: tag,
          labels,
          port: 8080,
          publishPort: "",
        });
        await docker.startContainer(mixed);
        expect(await docker.inspectContainer(mixed, 8080)).toMatchObject({
          running: true,
          appPort: 8080,
        });
        await docker.stopContainer(mixed);
        expect(await docker.inspectContainer(mixed, 8080)).toMatchObject({
          running: false,
          appPort: 8080,
        });
        await docker.removeContainer(mixed);
        await docker.removeImage(tag);
        await expect(docker.removeImage(tag)).rejects.toThrow(
          /^Docker DELETE \/images\/[^:]*: 404\b/,
        );
      },
    );
  },
  180000,
);
