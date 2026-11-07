import type {
  AppLocks,
  CaddyAdmin,
  DockerClient,
} from "../adapters/interfaces";
import type { Store } from "../store/interface";
import { destroyPreview, productionBranch } from "./previews";
export function previewTTL(
  value = process.env.HOIST_PREVIEW_TTL_DAYS ?? "7",
): number {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 365)
    throw new Error("HOIST_PREVIEW_TTL_DAYS must be an integer from 1 to 365.");
  return days;
}

export async function sweepPreviews(
  root: string,
  store: Store,
  docker: DockerClient,
  caddy: CaddyAdmin,
  locks: AppLocks,
  now = Date.now(),
  days = previewTTL(),
  report: (message: string) => void = console.error,
  signal?: AbortSignal,
): Promise<void> {
  const cutoff = now - days * 86400000;
  for (const candidate of store.apps()) {
    if (signal?.aborted) return;
    try {
      await locks.withLock(
        candidate.name,
        async () => {
          const app = store.app(candidate.name);
          if (!app) return;
          for (const preview of store.previews(app.id)) {
            if (signal?.aborted) return;
            const pushedAt = Date.parse(preview.last_push_at);
            if (!Number.isFinite(pushedAt)) {
              report(
                `Preview sweep ${app.name} ${preview.branch}: invalid last_push_at; skipped`,
              );
              continue;
            }
            if (pushedAt >= cutoff || productionBranch(app, preview.branch))
              continue;
            try {
              await destroyPreview(
                root,
                store,
                docker,
                caddy,
                app,
                preview.branch,
              );
              report(`Swept preview ${app.name} ${preview.branch}`);
            } catch (error) {
              report(
                `Preview sweep ${app.name} ${preview.branch}: ${String(error)}`,
              );
            }
          }
        },
        signal,
      );
    } catch (error) {
      if (!signal?.aborted)
        report(`Preview sweep ${candidate.name}: ${String(error)}`);
    }
  }
}
