import { expect } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { DockerClient } from "../../src/adapters/interfaces";
import type { App, Store } from "../../src/store/interface";

export async function assertPreviewGone(
  h: { store: Store; docker: DockerClient; data: string; admin: number },
  app: App,
  branch: string,
  slug: string,
  releases: { id: number }[],
): Promise<void> {
  expect(h.store.previews(app.id).some((p) => p.branch === branch)).toBe(false);
  expect(h.store.releases(app.id).some((r) => r.branch === branch)).toBe(false);
  const [containers, images, logs, routes] = await Promise.all([
    h.docker.listContainers({ "hoist.app": app.name, "hoist.branch": branch }),
    Promise.all(
      releases.map((r) =>
        h.docker.listImages({
          "hoist.app": app.name,
          "hoist.release": String(r.id),
        }),
      ),
    ),
    stat(join(h.data, "releases", app.name, slug)).catch(() => null),
    fetch(
      `http://127.0.0.1:${h.admin}/config/apps/http/servers/hoist/routes`,
    ).then((response) => response.json()),
  ]);
  expect(containers).toEqual([]);
  for (const releaseImages of images) expect(releaseImages).toEqual([]);
  expect(logs).toBeNull();
  expect(JSON.stringify(routes)).not.toContain(`${slug}.${app.domain}`);
}
