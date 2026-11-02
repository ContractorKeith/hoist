import type { DockerClient } from "../adapters/interfaces";
import type { App, Release, Store } from "../store/interface";
import { nextReleaseNumber } from "./releases";

export function rollbackTarget(rows: Release[], target?: string): Release {
  const main = rows.filter((row) => row.branch === "main");
  const live = main.findLast((row) => row.status === "live");
  if (!live) throw new Error("App has no live main release.");
  if (target !== undefined && !/^v[1-9][0-9]*$/.test(target))
    throw new Error("Rollback target must be vN.");
  const row =
    target !== undefined
      ? main.find((row) => row.number === Number(target.slice(1)))
      : main.findLast(
          (row) => row.status === "stopped" && row.number < live.number,
        );
  if (!row)
    throw new Error(
      target !== undefined
        ? `Unknown rollback target ${target}.`
        : "No previous stopped main release is available.",
    );
  if (row.status === "live")
    throw new Error(`v${row.number} is already live; use hoist restart <app>`);
  if (!["stopped", "built"].includes(row.status))
    throw new Error(`Cannot roll back to a ${row.status} release.`);
  return row;
}
export async function copyRelease(
  store: Store,
  docker: DockerClient,
  app: App,
  restart: boolean,
  target?: string,
): Promise<Release> {
  const rows = store.releases(app.id);
  const source = restart
    ? rows.findLast((row) => row.branch === "main" && row.status === "live")
    : rollbackTarget(rows, target);
  if (!source) throw new Error("App has no live main release.");
  try {
    await docker.imagePorts(source.image);
  } catch (error) {
    if (
      error instanceof Error &&
      /^Docker GET \/images\/.*: 404(?: |$)/.test(error.message)
    )
      throw new Error(
        `image for v${source.number} was pruned; cannot roll back`,
      );
    throw error;
  }
  return store.transaction(() =>
    store.insertRelease({
      app_id: app.id,
      branch: "main",
      number: nextReleaseNumber(store, app.id, "main"),
      git_sha: source.git_sha,
      image: source.image,
      config_json: restart
        ? JSON.stringify(store.config(app.id))
        : source.config_json,
      status: "built",
    }),
  );
}
