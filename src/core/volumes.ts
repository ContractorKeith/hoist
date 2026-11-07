import { posix } from "node:path";
import type { DockerClient } from "../adapters/interfaces";
import type { App, Store } from "../store/interface";
import { productionBranch } from "./previews";
import { appName } from "./validation";

export function volumePath(path: string): string {
  if (
    path.length > 255 ||
    !path.startsWith("/") ||
    path === "/" ||
    [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    path.split("/").includes("..") ||
    posix.normalize(path) !== path ||
    path.endsWith("/") ||
    /^\/(proc|sys|dev)(\/|$)/.test(path)
  )
    throw new Error(
      "Volume path must be absolute, normalized, at most 255 characters, and outside /, /proc, /sys and /dev",
    );
  return path;
}
export function volumeName(name: string): string {
  if (!name.startsWith("hoist-") || !name.endsWith("-data"))
    throw new Error("Invalid hoist volume name");
  appName(name.slice(6, -5));
  return name;
}
export const appVolumeName = (app: App) => volumeName(`hoist-${app.name}-data`);
export const volumeLabels = (app: App) => ({
  "hoist.app": app.name,
  "hoist.app-id": String(app.id),
});

export async function ownedVolume(docker: DockerClient, app: App) {
  const volume = (await docker.listVolumes()).find(
    (v) => v.name === appVolumeName(app),
  );
  if (
    volume &&
    Object.entries(volumeLabels(app)).some(
      ([key, value]) => volume.labels[key] !== value,
    )
  )
    throw new Error(
      `Volume ${volume.name} ownership does not match app ${app.name}`,
    );
  return volume;
}
export async function productionVolume(
  docker: DockerClient,
  app: App,
  branch: string,
) {
  if (!app.volume_path || !productionBranch(app, branch)) return undefined;
  const path = volumePath(app.volume_path);
  if (!(await ownedVolume(docker, app)))
    await docker.createVolume(appVolumeName(app), volumeLabels(app));
  return { name: appVolumeName(app), path };
}
export function setVolume(store: Store, app: App, path: string): void {
  volumePath(path);
  if (app.volume_path && app.volume_path !== path)
    throw new Error(
      "Cannot change the volume path; destroy the volume first with hoist apps:volume:rm <app> --force",
    );
  store.setVolumePath(app.id, path);
}
export async function removeAppVolume(
  docker: DockerClient,
  app: App,
): Promise<void> {
  if (!(await ownedVolume(docker, app))) return;
  const name = appVolumeName(app);
  try {
    await docker.removeVolume(name);
  } catch (error) {
    if (error instanceof Error && error.message.includes(": 409 "))
      throw new Error(`Stop containers using ${name}, then retry`, {
        cause: error,
      });
    throw error;
  }
}
