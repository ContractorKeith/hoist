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
          (row) =>
            row.status === "stopped" &&
            row.number < live.number &&
            !row.pruned_at,
        );
  if (!row)
    throw new Error(
      target !== undefined
        ? `Unknown rollback target ${target}.`
        : "No previous stopped main release is available.",
    );
  if (row.pruned_at) throw new Error(`Release v${row.number} has been pruned.`);
  if (!["live", "stopped", "built"].includes(row.status))
    throw new Error(`Cannot roll back to a ${row.status} release.`);
  return row;
}
export function copyRelease(
  store: Store,
  app: App,
  restart: boolean,
  target?: string,
): Release {
  return store.transaction(() => {
    const rows = store.releases(app.id);
    const source = restart
      ? rows.findLast((row) => row.branch === "main" && row.status === "live")
      : rollbackTarget(rows, target);
    if (!source) throw new Error("App has no live main release.");
    return store.insertRelease({
      app_id: app.id,
      branch: "main",
      number: nextReleaseNumber(store, app.id, "main"),
      git_sha: source.git_sha,
      image: source.image,
      config_json: restart
        ? JSON.stringify(store.config(app.id))
        : source.config_json,
      status: "built",
    });
  });
}
