import type { DockerClient } from "../adapters/interfaces";
import type { App, Store } from "../store/interface";
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
): Promise<void> {
  if (store.releases(app.id).some((release) => release.status === "building"))
    throw new Error(
      `a build is in progress for ${app.name}; wait for it to finish and retry`,
    );
  // TODO M2: remove containers and Caddy routes before deleting the app.
  // TODO M2 reconcile: fail stale building releases at startup.
  for (const image of await docker.listImages({ "hoist.app": app.name }))
    await docker.removeImage(image);
  await cleanup();
  store.deleteApp(app.id);
}
