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
  await provision();
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
  // TODO M2: remove containers and Caddy routes before deleting the app.
  for (const image of await docker.listImages({ "hoist.app": app.name }))
    await docker.removeImage(image);
  await cleanup();
  store.deleteApp(app.id);
}
