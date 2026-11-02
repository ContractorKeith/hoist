import { join } from "node:path";
import type {
  AppLocks,
  CaddyAdmin,
  DockerClient,
} from "../adapters/interfaces";
import { destroyPreview } from "../core/previews";
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
  refs = gitRefs,
): Promise<void> {
  for (const ref of parseRefs(input)) {
    if (!/^0+$/.test(ref.sha)) continue;
    await locks.withLock(
      app.name,
      async () => {
        const current = store.app(app.name);
        if (!current) return;
        // A later push may already have recreated the ref while this hook waited.
        if (await refs.head(join(root, "repos", `${app.name}.git`), ref.branch))
          return;
        await destroyPreview(root, store, docker, caddy, current, ref.branch);
      },
      signal,
    );
  }
}
