import { stat } from "node:fs/promises";
import { volumeName, volumePath } from "../core/volumes";
import type {
  BuildImage,
  Container,
  ContainerSpec,
  DockerClient,
  Labels,
  LogStream,
} from "./interfaces";
import * as validate from "./validation";

export class Docker implements DockerClient {
  private readonly socket: string;

  constructor(socket = process.env.DOCKER_HOST ?? "/var/run/docker.sock") {
    if (/^[a-z][a-z0-9+.-]*:/i.test(socket) && !socket.startsWith("unix://")) {
      throw new Error("Docker supports only unix sockets (unix://)");
    }
    this.socket = socket.replace(/^unix:\/\//, "");
    validate.absolutePath(this.socket);
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`http://localhost/v1.47${path}`, {
        signal: AbortSignal.timeout(30000),
        ...init,
        unix: this.socket,
      });
    } catch (error) {
      throw new Error(
        `cannot reach Docker at ${this.socket}: ${error instanceof Error ? error.message : String(error)}; is this user in the docker group?`,
        { cause: error },
      );
    }
    if (!response.ok && response.status !== 304)
      throw new Error(
        `Docker ${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`,
      );
    return response;
  }

  async listVolumes() {
    const row = (await (await this.request("/volumes")).json()) as {
      Volumes: { Name: string; Labels?: Labels | null }[] | null;
    };
    return (row.Volumes ?? []).map((v) => ({
      name: v.Name,
      labels: v.Labels ?? {},
    }));
  }
  async createVolume(name: string, labels: Labels): Promise<void> {
    volumeName(name);
    validate.labels(labels);
    await this.request("/volumes/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Name: name, Labels: labels }),
    });
  }
  async removeVolume(name: string): Promise<void> {
    volumeName(name);
    await this.request(`/volumes/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }
  async ping(): Promise<void> {
    await this.request("/_ping");
  }

  async buildImage(input: BuildImage, signal: AbortSignal): Promise<LogStream> {
    validate.absolutePath(input.contextDir);
    validate.imageName(input.tag);
    validate.labels(input.labels);
    if (!(await stat(input.contextDir)).isDirectory())
      throw new Error("Build context must be a directory");
    const connection = new AbortController();
    const buildSignal = AbortSignal.any([signal, connection.signal]);
    const archive = Bun.spawn(
      ["tar", "-C", input.contextDir, "-czf", "-", "."],
      { stdout: "pipe", stderr: "pipe" },
    );
    const archiveErrors = new Response(archive.stderr).text();
    try {
      const query = new URLSearchParams({
        t: input.tag,
        labels: JSON.stringify(input.labels),
        rm: "true",
        forcerm: "true",
      });
      const response = await this.request(`/build?${query}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-tar" },
        body: archive.stdout,
        signal: buildSignal,
      });
      if ((await archive.exited) !== 0) {
        await response.body?.cancel();
        throw new Error(`Build context archive failed: ${await archiveErrors}`);
      }
      // Docker reports build failures inside its successful HTTP response.
      let pending = "";
      const decoder = new TextDecoder();
      const check = (line: string) => {
        if (line.length > 1024 * 1024)
          throw new Error("Docker build log line too large");
        if (!line.trim()) return;
        const message = JSON.parse(line) as { error?: string };
        if (message.error) throw new Error(`Docker build: ${message.error}`);
      };
      if (!response.body) throw new Error("Docker build response missing body");
      const checked = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            pending += decoder.decode(chunk, { stream: true });
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) check(line);
            if (pending.length > 1024 * 1024)
              throw new Error("Docker build log line too large");
            controller.enqueue(chunk);
          },
          flush() {
            pending += decoder.decode();
            check(pending);
          },
        }),
      );
      const reader = checked.getReader();
      // Own the HTTP connection even when the consumer stops reading mid-build.
      return new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const { value, done } = await reader.read();
              if (done) {
                reader.releaseLock();
                controller.close();
              } else controller.enqueue(value);
            } catch (error) {
              connection.abort(error);
              controller.error(error);
            }
          },
          async cancel(reason) {
            connection.abort(reason);
            await reader.cancel(reason).catch(() => {});
            reader.releaseLock();
          },
        },
        { highWaterMark: 0 },
      );
    } catch (error) {
      connection.abort(error);
      throw error;
    } finally {
      if (archive.exitCode === null) archive.kill();
      await archive.exited;
      await archiveErrors;
    }
  }

  async imagePorts(image: string): Promise<number[]> {
    validate.imageName(image);
    const row = (await (
      await this.request(`/images/${encodeURIComponent(image)}/json`)
    ).json()) as { Config: { ExposedPorts?: Record<string, unknown> } };
    return Object.keys(row.Config.ExposedPorts ?? {})
      .filter((key) => /^[0-9]+\/tcp$/.test(key))
      .map((key) => {
        const port = Number(key.split("/")[0]);
        validate.port(port);
        return port;
      });
  }

  async inspectContainer(
    id: string,
    appPort?: number,
  ): Promise<{
    running: boolean;
    port: number;
    appPort: number;
    labels: Labels;
  } | null> {
    validate.containerId(id);
    let response: Response;
    try {
      response = await this.request(`/containers/${id}/json`);
    } catch (error) {
      if (error instanceof Error && error.message.includes(": 404 "))
        return null;
      throw error;
    }
    const row = (await response.json()) as {
      State: { Running: boolean };
      Config: { Labels?: Labels };
      HostConfig: {
        PortBindings?: Record<
          string,
          { HostIp: string; HostPort: string }[] | null
        >;
      };
      NetworkSettings: {
        Ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
      };
    };
    const ports = row.NetworkSettings.Ports ?? {};
    const published = row.HostConfig.PortBindings ?? {};
    const selected =
      appPort ??
      Number(
        Object.keys(published)
          .find((key) =>
            published[key]?.some((binding) => binding.HostIp === "127.0.0.1"),
          )
          ?.split("/")[0],
      );
    validate.port(selected);
    const binding = ports[`${selected}/tcp`]?.find(
      (value) => value.HostIp === "127.0.0.1",
    );
    const port = Number(binding?.HostPort ?? 0);
    if (row.State.Running) validate.port(port);
    const labels = row.Config.Labels ?? {};
    validate.labels(labels);
    return { running: row.State.Running, port, appPort: selected, labels };
  }

  async createContainer(input: ContainerSpec): Promise<string> {
    validate.imageName(input.image);
    validate.labels(input.labels);
    validate.port(input.port);
    if (input.publishPort !== "") validate.port(input.publishPort);
    if (
      input.config !== undefined &&
      (input.config === null ||
        Array.isArray(input.config) ||
        typeof input.config !== "object")
    )
      throw new Error("Invalid container config");
    const config = Object.entries(input.config ?? {});
    if (
      config.length > 256 ||
      config.some(
        ([key, value]) =>
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ||
          typeof value !== "string" ||
          value.includes("\0") ||
          value.length > 65536,
      )
    ) {
      throw new Error("Invalid container config");
    }
    if (input.volume) {
      volumeName(input.volume.name);
      volumePath(input.volume.path);
    }
    const response = await this.request("/containers/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Image: input.image,
        Labels: input.labels,
        Env: config.map(([key, value]) => `${key}=${value}`),
        // TTY makes the log stream plain bytes rather than Docker multiplex frames.
        Tty: true,
        ExposedPorts: { [`${input.port}/tcp`]: {} },
        HostConfig: {
          Mounts: input.volume
            ? [
                {
                  Type: "volume",
                  Source: input.volume.name,
                  Target: input.volume.path,
                  ReadOnly: false,
                },
              ]
            : [],
          PortBindings: {
            [`${input.port}/tcp`]: [
              { HostIp: "127.0.0.1", HostPort: String(input.publishPort) },
            ],
          },
        },
      }),
    });
    return ((await response.json()) as { Id: string }).Id;
  }

  async startContainer(id: string): Promise<void> {
    validate.containerId(id);
    await this.request(`/containers/${id}/start`, { method: "POST" });
  }
  async stopContainer(id: string): Promise<void> {
    validate.containerId(id);
    await this.request(`/containers/${id}/stop?t=2`, { method: "POST" });
  }
  async removeContainer(id: string): Promise<void> {
    validate.containerId(id);
    await this.request(`/containers/${id}?force=true&v=true`, {
      method: "DELETE",
    });
  }
  async containerLogs(
    id: string,
    follow = false,
    signal?: AbortSignal,
    tail?: number,
  ): Promise<LogStream> {
    validate.containerId(id);
    if (
      tail !== undefined &&
      (!Number.isInteger(tail) || tail < 1 || tail > 10000)
    )
      throw new Error("Invalid log tail");
    const response = await this.request(
      `/containers/${id}/logs?stdout=true&stderr=true&follow=${follow}&tail=${tail ?? "all"}`,
      {
        signal: follow
          ? (signal ?? null)
          : signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
            : AbortSignal.timeout(30000),
      },
    );
    if (!response.body) throw new Error("Docker logs response missing body");
    return response.body;
  }

  async listContainers(labels: Labels): Promise<Container[]> {
    validate.labels(labels);
    const filters = new URLSearchParams({
      all: "true",
      filters: JSON.stringify({
        label: Object.entries(labels).map(([key, value]) => `${key}=${value}`),
      }),
    });
    const rows = (await (
      await this.request(`/containers/json?${filters}`)
    ).json()) as { Id: string; Image: string; Labels: Labels }[];
    return rows.map((row) => ({
      id: row.Id,
      image: row.Image,
      labels: row.Labels,
    }));
  }
  async listImages(labels: Labels): Promise<string[]> {
    validate.labels(labels);
    const filters = new URLSearchParams({
      all: "true",
      filters: JSON.stringify({
        label: Object.entries(labels).map(([key, value]) => `${key}=${value}`),
      }),
    });
    const rows = (await (
      await this.request(`/images/json?${filters}`)
    ).json()) as { Id: string }[];
    return rows.map((row) => row.Id);
  }
  async removeImage(image: string): Promise<void> {
    validate.imageName(image);
    await this.request(`/images/${encodeURIComponent(image)}`, {
      method: "DELETE",
    });
  }
}
