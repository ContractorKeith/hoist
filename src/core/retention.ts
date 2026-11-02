import type { DockerClient } from "../adapters/interfaces";
import type { App, Release, Store } from "../store/interface";
import { branchSlug } from "./validation";

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

// Cleanup must never turn an already-completed cutover into a rejected push.
export async function prune(
  store: Store,
  docker: DockerClient,
  app: App,
  removeLogs: (release: Release) => Promise<void>,
  log: (message: string) => Promise<void> = async () => {},
  branch?: string,
): Promise<void> {
  const report = async (path: string, error: unknown) => {
    const actualPath = (error as { path?: string } | null)?.path ?? path;
    const detail = error instanceof Error ? error.message : String(error);
    const message = `prune: could not remove ${actualPath}: ${detail}`.replace(
      /[\r\n]+/g,
      " ",
    );
    try {
      console.error(message);
    } catch {
      /* Logging cannot reject a completed cutover. */
    }
    try {
      await log(message);
    } catch {
      /* The file may also be unwritable. */
    }
  };
  try {
    const rows = store.releases(app.id);
    const selected = retentionSelection(
      branch === undefined
        ? rows
        : rows.filter((row) => branchSlug(row.branch) === branchSlug(branch)),
      store.app(app.name)?.retention ?? 5,
    );
    const ids = new Set(selected.map((row) => row.id));
    const protectedImages = new Set(
      rows
        .filter((row) => !row.pruned_at && !ids.has(row.id))
        .map((row) => row.image),
    );
    const attemptedImages = new Set<string>();
    for (const row of selected) {
      let failure: { path: string; error: unknown } | undefined;
      const path = `releases/${app.name}/${branchSlug(row.branch)}/v${row.number}`;
      try {
        if (
          !protectedImages.has(row.image) &&
          !attemptedImages.has(row.image)
        ) {
          attemptedImages.add(row.image);
          try {
            await docker.removeImage(row.image);
          } catch (error) {
            // The Docker adapter includes the HTTP status in its error message.
            if (
              !(
                error instanceof Error &&
                /^Docker DELETE \/images\/[^:]*: 404\b/.test(error.message)
              )
            )
              failure = { path: row.image, error };
          }
        }
        // Keep failed logs, but finish their one image-cleanup attempt.
        if (row.status !== "failed") await removeLogs(row);
        store.markPruned(row.id);
      } catch (error) {
        failure = { path, error };
      }
      if (failure) await report(failure.path, failure.error);
    }
  } catch (error) {
    await report(`releases/${app.name}`, error);
  }
}
