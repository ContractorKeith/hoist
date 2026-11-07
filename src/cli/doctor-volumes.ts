import type { DockerClient } from "../adapters/interfaces";
import { appVolumeName, volumeLabels } from "../core/volumes";
import type { Store } from "../store/interface";

export async function checkVolumes(
  store: Store,
  docker: DockerClient,
): Promise<string> {
  const apps = store.apps();
  const volumes = await docker.listVolumes(["hoist.app"]);
  const lines: string[] = [],
    problems: string[] = [];
  for (const app of apps) {
    if (!app.volume_path) continue;
    const name = appVolumeName(app);
    const volume = volumes.find((v) => v.name === name);
    lines.push(`${app.name}: ${name} at ${app.volume_path}`);
    if (!volume)
      problems.push(
        `WARNING: configured volume ${name} is MISSING; the next production release will recreate it EMPTY. Restore from backup before deploying.`,
      );
    else if (
      Object.entries(volumeLabels(app)).some(([k, v]) => volume.labels[k] !== v)
    )
      problems.push(`Volume ${name} ownership does not match app ${app.name}`);
  }
  const known = new Set(
    apps.filter((app) => app.volume_path).map((app) => String(app.id)),
  );
  for (const volume of volumes)
    if (!known.has(volume.labels["hoist.app-id"] ?? ""))
      problems.push(
        `Orphan volume ${volume.name}: no configured app with this id; inspect before removing`,
      );
  if (problems.length) throw new Error([...lines, ...problems].join("; "));
  return lines.join("; ") || "No app volumes configured.";
}
