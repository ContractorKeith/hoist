import type { CaddyAdmin, DockerClient } from "../adapters/interfaces";
import type { App, Store } from "../store/interface";
import { removeImages } from "./build";
import { appName, healthPath } from "./validation";

export function knownApp(store: Store, name: string): App {
  const app = store.app(appName(name));
  if (!app)
    throw new Error(`Unknown app ${name}; run hoist apps:create ${name} first`);
  return app;
}

export async function createApp(
  store: Store,
  name: string,
  domain: string,
  health: string,
  provision: () => Promise<void>,
  cleanup: () => Promise<void>,
): Promise<App> {
  appName(name);
  healthPath(health);
  if (store.app(name)) throw new Error("App already exists");
  try {
    await provision();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error("App already exists");
    throw error;
  }
  try {
    return store.createApp(name, domain, health);
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function destroyApp(
  store: Store,
  docker: DockerClient,
  app: App,
  cleanup: () => Promise<void>,
  caddy: CaddyAdmin,
  warn: (message: string) => void = console.error,
): Promise<void> {
  if (store.releases(app.id).some((release) => release.status === "building"))
    throw new Error(
      `a build is in progress for ${app.name}; wait for it to finish and retry`,
    );
  for (const container of await docker.listContainers({
    "hoist.app": app.name,
  })) {
    await docker.stopContainer(container.id);
    await docker.removeContainer(container.id);
  }
  await removeImages(docker, { "hoist.app": app.name });
  await cleanup();
  store.deleteApp(app.id);
  try {
    await caddy.removeRoute(app.domain);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("Caddy admin API not reachable")
    )
      throw error;
    warn(
      "Caddy not reachable; routes are rebuilt from the store when hoist serve starts",
    );
  }
}
