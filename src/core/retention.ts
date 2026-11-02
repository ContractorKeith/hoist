import type { DockerClient } from "../adapters/interfaces";
import type { App, Release, Store } from "../store/interface";

export function retentionSelection(rows: Release[], count: number): Release[] {
  const keep = new Set<number>();
  const branches = new Set(rows.map((row) => row.branch));
  for (const branch of branches) {
    const eligible = rows
      .filter(
        (row) =>
          row.branch === branch &&
          !row.pruned_at &&
          ["live", "stopped", "built"].includes(row.status),
      )
      .sort((a, b) => b.number - a.number);
    for (const row of eligible.slice(0, count)) keep.add(row.id);
  }
  return rows.filter(
    (row) =>
      !row.pruned_at &&
      row.status !== "live" &&
      (row.status === "failed" ||
        (["live", "stopped", "built"].includes(row.status) &&
          !keep.has(row.id))),
  );
}
export async function prune(
  store: Store,
  docker: DockerClient,
  app: App,
  removeLogs: (release: Release) => Promise<void>,
): Promise<void> {
  const rows = store.releases(app.id),
    selected = retentionSelection(rows, store.app(app.name)?.retention ?? 5);
  const ids = new Set(selected.map((row) => row.id));
  const protectedImages = new Set(
    rows
      .filter((row) => !row.pruned_at && !ids.has(row.id))
      .map((row) => row.image),
  );
  for (const row of selected) {
    if (!protectedImages.has(row.image))
      await docker.removeImage(row.image).catch(() => {});
    // Failed build logs remain available to logs --release after image pruning.
    if (row.status !== "failed") await removeLogs(row);
    store.markPruned(row.id);
  }
}
