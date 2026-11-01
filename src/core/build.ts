import type { DockerClient } from "../adapters/interfaces";
import type { App, Release, Store } from "../store/interface";
import { nextReleaseNumber } from "./releases";
import { branchSlug } from "./validation";

export function reserveRelease(
  store: Store,
  app: App,
  branch: string,
  sha: string,
): Release {
  const slug = branchSlug(branch);
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid git SHA");
  return store.transaction(() => {
    if (
      store
        .releases(app.id)
        .some((row) => row.branch !== branch && branchSlug(row.branch) === slug)
    )
      throw new Error("Branch slug collides with an existing branch");
    const number = nextReleaseNumber(store, app.id, branch);
    return store.insertRelease({
      app_id: app.id,
      branch,
      number,
      git_sha: sha,
      image: `hoist/${app.name}:${slug}-v${number}-${sha.slice(0, 12)}`,
      config_json: "{}",
      status: "building",
    });
  });
}

// The hook supplies a confined checkout and durable log sink; core owns release transitions.
export async function buildRelease(
  store: Store,
  docker: DockerClient,
  release: Release,
  app: App,
  prepare: () => Promise<string>,
  log: (chunk: Uint8Array) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  try {
    signal.throwIfAborted();
    const contextDir = await prepare();
    const stream = await docker.buildImage(
      {
        contextDir,
        tag: release.image,
        labels: {
          "hoist.app": app.name,
          "hoist.release": String(release.id),
          "hoist.sha": release.git_sha,
        },
      },
      signal,
    );
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await log(value);
      }
      signal.throwIfAborted();
      store.completeRelease(release.id);
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    store.failRelease(release.id);
    await log(
      new TextEncoder().encode(
        `${error instanceof Error ? error.message : String(error)}\n`,
      ),
    ).catch(() => {});
    await removeReleaseImages(docker, app, release);
    throw error;
  }
}

// Cleanup is best-effort; one Docker error must not hide the build error or skip other images.
export async function removeReleaseImages(
  docker: DockerClient,
  app: App,
  release: Release,
): Promise<void> {
  const images = await docker
    .listImages({ "hoist.app": app.name, "hoist.release": String(release.id) })
    .catch(() => []);
  for (const image of images) {
    try {
      await docker.removeImage(image);
    } catch {
      /* Keep cleaning the remaining images. */
    }
  }
}
