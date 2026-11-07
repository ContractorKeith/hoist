import { SqliteAppLocks } from "../adapters/app-lock";
import { Docker } from "../adapters/docker";
import { knownApp } from "../core/apps";
import { appVolumeName, removeAppVolume } from "../core/volumes";
import type { Store } from "../store/interface";

export async function volumeRemoveCommand(
  _root: string,
  store: Store,
  args: string[],
): Promise<void> {
  if (args.length !== 3 || args[2] !== "--force")
    throw new Error("Usage: hoist apps:volume:rm <app> --force");
  const app = knownApp(store, args[1] ?? "");
  const lease = await new SqliteAppLocks(store).acquire(`app:${app.name}`, {
    failFast: true,
  });
  try {
    if (store.releases(app.id).some((r) => r.status === "building"))
      throw new Error(`a build is in progress for ${app.name}`);
    // Docker refuses deletion when any container still references the volume.
    await removeAppVolume(new Docker(), app);
    store.setVolumePath(app.id, null);
    console.log(`Removed volume ${appVolumeName(app)}; volume path cleared`);
  } finally {
    lease.release();
  }
}
