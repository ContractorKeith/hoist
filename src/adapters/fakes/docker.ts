import type {
  BuildImage,
  Container,
  ContainerSpec,
  DockerClient,
  Labels,
  LogStream,
} from "../interfaces";

export class FakeDocker implements DockerClient {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly containers = new Map<string, Container>();
  readonly images = new Map<string, Labels>();
  readonly volumes = new Map<string, Labels>();
  async listVolumes() {
    this.record("listVolumes");
    return [...this.volumes].map(([name, labels]) => ({ name, labels }));
  }
  async createVolume(name: string, labels: Labels): Promise<void> {
    this.record("createVolume", name, labels);
    if (!this.volumes.has(name)) this.volumes.set(name, labels);
  }
  async removeVolume(name: string): Promise<void> {
    this.record("removeVolume", name);
    this.volumes.delete(name);
  }
  readonly running = new Set<string>();
  exposedPorts: number[] = [8080];
  async imagePorts(image: string): Promise<number[]> {
    this.record("imagePorts", image);
    return [...this.exposedPorts];
  }
  async inspectContainer(
    id: string,
    appPort = 8080,
  ): Promise<{
    running: boolean;
    port: number;
    appPort: number;
    labels: Labels;
  } | null> {
    this.record("inspectContainer", id);
    return this.containers.has(id)
      ? {
          running: this.running.has(id),
          appPort,
          labels: structuredClone(this.containers.get(id)?.labels ?? {}),
          port: 30000 + Number.parseInt(id.slice(-4), 16),
        }
      : null;
  }
  private sequence = 0;

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({
      method,
      args: args.map((arg) =>
        arg instanceof AbortSignal ? arg : structuredClone(arg),
      ),
    });
  }
  async ping(): Promise<void> {
    this.record("ping");
  }
  async buildImage(input: BuildImage, signal: AbortSignal): Promise<LogStream> {
    this.record("buildImage", input, signal);
    this.images.set(input.tag, structuredClone(input.labels));
    return new Blob(["built\n"]).stream();
  }
  async createContainer(input: ContainerSpec): Promise<string> {
    this.record("createContainer", input);
    const id = (++this.sequence).toString(16).padStart(64, "0");
    this.containers.set(id, {
      id,
      image: input.image,
      labels: structuredClone(input.labels),
    });
    return id;
  }
  async startContainer(id: string): Promise<void> {
    this.record("startContainer", id);
    this.running.add(id);
  }
  async stopContainer(id: string): Promise<void> {
    this.record("stopContainer", id);
    this.running.delete(id);
  }
  async removeContainer(id: string): Promise<void> {
    this.record("removeContainer", id);
    this.containers.delete(id);
    this.running.delete(id);
  }
  async containerLogs(
    id: string,
    follow = false,
    signal?: AbortSignal,
    tail?: number,
  ): Promise<LogStream> {
    this.record("containerLogs", id, follow, signal, tail);
    return new Blob(["hello\n"]).stream();
  }
  async listContainers(labels: Labels): Promise<Container[]> {
    this.record("listContainers", labels);
    return structuredClone(
      [...this.containers.values()].filter((item) =>
        Object.entries(labels).every(
          ([key, value]) => item.labels[key] === value,
        ),
      ),
    );
  }
  async listImages(labels: Labels): Promise<string[]> {
    this.record("listImages", labels);
    return [...this.images]
      .filter(([, values]) =>
        Object.entries(labels).every(([key, value]) => values[key] === value),
      )
      .map(([image]) => image);
  }
  async removeImage(image: string): Promise<void> {
    this.record("removeImage", image);
    this.images.delete(image);
  }
}
