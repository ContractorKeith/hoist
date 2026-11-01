import { stat } from "node:fs/promises";
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
    this.socket = socket.replace(/^unix:\/\//, "");
    validate.absolutePath(this.socket);
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const response = await fetch(`http://localhost/v1.47${path}`, {
      ...init,
      unix: this.socket,
    });
    if (!response.ok)
      throw new Error(
        `Docker ${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`,
      );
    return response;
  }

  async ping(): Promise<void> {
    await this.request("/_ping");
  }

  async buildImage(input: BuildImage): Promise<LogStream> {
    validate.absolutePath(input.contextDir);
    validate.imageName(input.tag);
    validate.labels(input.labels);
    if (!(await stat(input.contextDir)).isDirectory())
      throw new Error("Build context must be a directory");
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
      return response.body.pipeThrough(
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
    } finally {
      if (archive.exitCode === null) archive.kill();
      await archive.exited;
      await archiveErrors;
    }
  }

  async createContainer(input: ContainerSpec): Promise<string> {
    validate.imageName(input.image);
    validate.labels(input.labels);
    validate.port(input.port);
    validate.port(input.publishPort);
    const config = Object.entries(input.config ?? {});
    if (
      config.length > 256 ||
      config.some(
        ([key, value]) =>
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ||
          value.includes("\0") ||
          value.length > 65536,
      )
    ) {
      throw new Error("Invalid container config");
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
  async containerLogs(id: string, follow = false): Promise<LogStream> {
    validate.containerId(id);
    const response = await this.request(
      `/containers/${id}/logs?stdout=true&stderr=true&follow=${follow}`,
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
