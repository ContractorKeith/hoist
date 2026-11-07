import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { CaddyAdmin, DockerClient } from "../adapters/interfaces";
import { hostName } from "../adapters/validation";
import { privatePath } from "../data";
import type { App, Store } from "../store/interface";
import { removeImages } from "./build";
import { assertAppHost } from "./caddy-config";
import { removeReleaseLogs } from "./logs";
import { branchSlug } from "./validation";

export function previewHost(app: App, branch: string): string {
  const host = `${branchSlug(branch)}.${app.domain}`;
  try {
    hostName(host);
    return host;
  } catch {
    throw new Error(
      "Preview host must be at most 253 characters with labels at most 63 characters.",
    );
  }
}

export function productionBranch(app: App, branch: string): boolean {
  return (
    branch === (app.main_branch ?? "main") || branch === app.pending_main_branch
  );
}
export function branchSettings(app: App, branch: string): App {
  return app.volume_path
    ? {
        ...app,
        pending_main_branch:
          branch === (app.main_branch ?? "main") ? null : branch,
      }
    : { ...app, main_branch: branch, pending_main_branch: null };
}
export function releaseHost(app: App, branch: string): string {
  return productionBranch(app, branch) ? app.domain : previewHost(app, branch);
}

export function ownsPreview(store: Store, app: App, branch: string): boolean {
  return (
    store.previews(app.id).some((row) => row.branch === branch) ||
    store.releases(app.id).some((row) => row.branch === branch)
  );
}

export function requirePreview(store: Store, app: App, branch: string): void {
  if (productionBranch(app, branch))
    throw new Error("The main branch cannot be destroyed as a preview.");
  if (!ownsPreview(store, app, branch))
    throw new Error(`no preview ${branch} for ${app.name}`);
}

// Caller holds the app lease for the entire teardown.
export async function destroyPreview(
  root: string,
  store: Store,
  docker: DockerClient,
  caddy: CaddyAdmin,
  app: App,
  branch: string,
  removeRef: () => Promise<void> = async () => {},
): Promise<void> {
  requirePreview(store, app, branch);
  const host = previewHost(app, branch);
  const releases = store.releases(app.id).filter((r) => r.branch === branch);
  if (
    store
      .previews(app.id)
      .some((row) => row.slug === branchSlug(branch) && row.branch !== branch)
  )
    return;
  store.stopBranchReleases(app.id, branch);
  await removeRef();
  for (const container of await docker.listContainers({
    "hoist.app": app.name,
  })) {
    if (
      container.labels["hoist.branch"] !== branch &&
      !releases.some((r) => String(r.id) === container.labels["hoist.release"])
    )
      continue;
    await docker.stopContainer(container.id);
    await docker.removeContainer(container.id);
  }
  await caddy.removeRoute(host);
  for (const release of releases)
    await removeImages(docker, {
      "hoist.app": app.name,
      "hoist.release": String(release.id),
    });
  for (const release of releases)
    await removeReleaseLogs(root, app.name, branch, release.number, store);
  const path = privatePath(
    join(root, "releases", app.name, branchSlug(branch)),
    true,
    false,
    root,
  );
  await rm(path, { recursive: true, force: true });
  store.deletePreview(app.id, branch);
}

export { previewTTL, sweepPreviews } from "./preview-sweep";

// Check the global routing namespace before reserving app or preview hosts.
export function availableHost(
  store: Store,
  host: string,
  owner?: number,
): void {
  assertAppHost(host);
  for (const app of store.apps()) {
    if (app.id === owner) continue;
    if (
      app.domain === host ||
      store.previews(app.id).some((p) => previewHost(app, p.branch) === host) ||
      store
        .releases(app.id)
        .some(
          (r) =>
            r.branch !== (app.main_branch ?? "main") &&
            previewHost(app, r.branch) === host,
        )
    )
      throw new Error(`host ${host} is already used by app ${app.name}`);
  }
}

export function reclassification(
  store: Store,
  app: App,
  branch: string,
): string[] {
  branchSlug(branch);
  if (
    app.volume_path &&
    branch !== (app.main_branch ?? "main") &&
    store
      .releases(app.id)
      .some((r) => r.branch === branch && r.status === "live")
  )
    throw new Error(
      "Cannot promote a live preview with a volume configured; destroy the preview first: its container has no volume",
    );
  const branches = [
    ...new Set([
      branch,
      ...store.releases(app.id).map((r) => r.branch),
      ...store.previews(app.id).map((p) => p.branch),
    ]),
  ];
  const slugs = new Map<string, string>();
  const updated = branchSettings(app, branch);
  for (const name of branches) {
    const slug = branchSlug(name);
    const existing = slugs.get(slug);
    if (existing && existing !== name)
      throw new Error(`Branch slug collides with existing branch ${existing}`);
    slugs.set(slug, name);
    availableHost(store, releaseHost(updated, name), app.id);
  }
  return branches.filter((name) => !productionBranch(updated, name));
}

export function setMainBranch(
  store: Store,
  app: App,
  branch: string,
  now = new Date().toISOString(),
): void {
  const converted = reclassification(store, app, branch);
  store.transaction(() => {
    for (const name of converted)
      if (!store.previews(app.id).some((p) => p.branch === name))
        store.upsertPreview({
          app_id: app.id,
          branch: name,
          slug: branchSlug(name),
          last_push_at: now,
        });
    store.removePreview(app.id, branch);
    if (app.volume_path)
      store.setPendingMainBranch(
        app.id,
        branchSettings(app, branch).pending_main_branch ?? null,
      );
    else {
      store.setMainBranch(app.id, branch);
      store.setPendingMainBranch(app.id, null);
    }
  });
}
