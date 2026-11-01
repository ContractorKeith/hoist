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
  async buildImage(
    input: BuildImage,
    signal?: AbortSignal,
  ): Promise<LogStream> {
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
  }
  async stopContainer(id: string): Promise<void> {
    this.record("stopContainer", id);
  }
  async removeContainer(id: string): Promise<void> {
    this.record("removeContainer", id);
    this.containers.delete(id);
  }
  async containerLogs(
    id: string,
    follow = false,
    signal?: AbortSignal,
  ): Promise<LogStream> {
    this.record("containerLogs", id, follow, signal);
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
