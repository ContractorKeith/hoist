export type Labels = Record<string, string>;
export type LogStream = ReadableStream<Uint8Array>;

export interface BuildImage {
  contextDir: string;
  tag: string;
  labels: Labels;
}

export interface ContainerSpec {
  image: string;
  labels: Labels;
  port: number;
  // A loopback-only published port for Caddy to reach.
  publishPort: number;
  config?: Record<string, string>;
}

export interface Container {
  id: string;
  image: string;
  labels: Labels;
}

export interface DockerClient {
  ping(): Promise<void>;
  // Consume the stream to finish the build; stream errors fail the build.
  buildImage(input: BuildImage, signal?: AbortSignal): Promise<LogStream>;
  createContainer(input: ContainerSpec): Promise<string>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string): Promise<void>;
  removeContainer(id: string): Promise<void>;
  containerLogs(
    id: string,
    follow?: boolean,
    signal?: AbortSignal,
  ): Promise<LogStream>;
  listContainers(labels: Labels): Promise<Container[]>;
  listImages(labels: Labels): Promise<string[]>;
  removeImage(image: string): Promise<void>;
}

export type CaddyConfig = Record<string, unknown>;

export interface CaddyAdmin {
  loadConfig(config: CaddyConfig): Promise<void>;
  upsertRoute(host: string, upstream: string): Promise<void>;
  removeRoute(host: string): Promise<void>;
}
