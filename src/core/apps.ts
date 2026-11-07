import type { CaddyAdmin, DockerClient } from "../adapters/interfaces";
import type { App, Store } from "../store/interface";
import { removeImages } from "./build";
import { availableHost, previewHost, releaseHost } from "./previews";
import { appName, healthPath } from "./validation";
import { ownedVolume, volumePath } from "./volumes";

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
  volume?: string,
): Promise<App> {
  appName(name);
  healthPath(health);
  if (volume !== undefined) volumePath(volume);
  if (store.app(name)) throw new Error("App already exists");
  availableHost(store, domain);
  try {
    await provision();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error("App already exists");
    throw error;
  }
  try {
    return store.transaction(() => {
      availableHost(store, domain);
      const app = store.createApp(name, domain, health);
      if (volume !== undefined) store.setVolumePath(app.id, volume);
      return store.app(name) ?? app;
    });
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
  deleteVolume = false,
): Promise<void> {
  if (store.releases(app.id).some((release) => release.status === "building"))
    throw new Error(
      `a build is in progress for ${app.name}; wait for it to finish and retry`,
    );
  // Data is deleted only on an explicit flag; refuse before touching anything.
  const volume = await ownedVolume(docker, app);
  if (volume && !deleteVolume)
    throw new Error(
      `${app.name} has volume ${volume.name}; pass --delete-volume to delete it and all its data`,
    );
  for (const container of await docker.listContainers({
    "hoist.app": app.name,
  })) {
    await docker.stopContainer(container.id);
    await docker.removeContainer(container.id);
  }
  if (volume) {
    warn(`Destroying volume ${volume.name} and all its data`);
    await docker.removeVolume(volume.name);
  }
  await removeImages(docker, { "hoist.app": app.name });
  const hosts = new Set([
    app.domain,
    ...store.previews(app.id).map((row) => previewHost(app, row.branch)),
    ...store.releases(app.id).map((row) => releaseHost(app, row.branch)),
  ]);
  await cleanup();
  store.deleteApp(app.id);
  try {
    for (const host of hosts) await caddy.removeRoute(host);
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
