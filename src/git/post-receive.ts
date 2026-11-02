import { join } from "node:path";
import type {
  AppLocks,
  CaddyAdmin,
  DockerClient,
} from "../adapters/interfaces";
import { destroyPreview, ownsPreview } from "../core/previews";
import type { App, Store } from "../store/interface";
import { parseRefs } from "./refs";
import { gitRefs } from "./repository";

// Git has committed ref updates before invoking this hook.
export async function receiveDeleted(
  root: string,
  store: Store,
  docker: DockerClient,
  caddy: CaddyAdmin,
  locks: AppLocks,
  app: App,
  input: string,
  signal: AbortSignal,
  startedAt = Date.now(),
  refs = gitRefs,
  report: (message: string) => void = console.error,
): Promise<void> {
  const left: string[] = [];
  for (const ref of parseRefs(input)) {
    if (!/^0+$/.test(ref.sha)) continue;
    try {
      await locks.withLock(
        app.name,
        async () => {
          const current = store.app(app.name);
          if (!current || !ownsPreview(store, current, ref.branch)) {
            report(`hoist: ${ref.branch} had no preview; nothing to tear down`);
            return;
          }
          const recreated = store
            .releases(current.id)
            .some(
              (row) =>
                row.branch === ref.branch &&
                Date.parse(row.created_at ?? "") > startedAt,
            );
          if (
            recreated ||
            (await refs.head(
              join(root, "repos", `${app.name}.git`),
              ref.branch,
            ))
          ) {
            report(
              `branch ${ref.branch} was recreated after this deletion; keeping it`,
            );
            return;
          }
          await destroyPreview(root, store, docker, caddy, current, ref.branch);
        },
        signal,
      );
    } catch (error) {
      report(`hoist: teardown ${ref.branch} failed: ${String(error)}`);
      if (ownsPreview(store, app, ref.branch)) left.push(ref.branch);
    }
  }
  if (left.length) throw new Error(`previews left behind: ${left.join(", ")}`);
}
