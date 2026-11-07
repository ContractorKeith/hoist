import { expect, test } from "bun:test";
import { destroyConfirmation } from "../../src/cli/apps";
import { checkVolumes } from "../../src/cli/doctor-volumes";
import { destroyApp } from "../../src/core/apps";
import { appVolumeName, volumeLabels } from "../../src/core/volumes";
import { previewFixture } from "./preview-support";

test("destroy refuses a foreign volume before changing any app resources", async () => {
  const h = await previewFixture("sqlite");
  try {
    h.store.setVolumePath(h.app.id, "/data");
    const id = await h.docker.createContainer({
      image: "hoist/blog:live",
      port: 8080,
      publishPort: "",
      labels: { "hoist.app": "blog" },
    });
    await h.docker.startContainer(id);
    h.docker.volumes.set(appVolumeName(h.app), {});
    let removedFiles = false;
    await expect(
      destroyApp(
        h.store,
        h.docker,
        h.app,
        async () => {
          removedFiles = true;
        },
        h.caddy,
      ),
    ).rejects.toThrow("ownership");
    expect(h.docker.running.has(id)).toBe(true);
    expect(h.store.app("blog")).not.toBeNull();
    expect(removedFiles).toBe(false);
  } finally {
    await h.cleanup();
  }
});

test("doctor ignores unlabelled volumes but flags orphan IDs and apps without volume config", async () => {
  const h = await previewFixture("sqlite");
  try {
    h.docker.volumes.set("hoist-registry-data", {});
    expect(await checkVolumes(h.store, h.docker)).toBe(
      "No app volumes configured.",
    );
    h.docker.volumes.set("hoist-old-data", {
      "hoist.app": "old",
      "hoist.app-id": "999",
    });
    await expect(checkVolumes(h.store, h.docker)).rejects.toThrow(
      "Orphan volume hoist-old-data",
    );
    h.docker.volumes.delete("hoist-old-data");
    h.docker.volumes.set(appVolumeName(h.app), volumeLabels(h.app));
    await expect(checkVolumes(h.store, h.docker)).rejects.toThrow(
      "no configured app",
    );
  } finally {
    await h.cleanup();
  }
});

test("destroy refuses an untracked clone even when it inherits valid app image labels", async () => {
  const h = await previewFixture("sqlite");
  try {
    h.store.setVolumePath(h.app.id, "/data");
    h.docker.volumes.set(appVolumeName(h.app), volumeLabels(h.app));
    const release = h.store.insertRelease({
      app_id: h.app.id,
      branch: "main",
      number: 1,
      git_sha: "a".repeat(40),
      image: "hoist/blog:live",
      config_json: "{}",
      status: "built",
    });
    const spec = {
      image: release.image,
      port: 8080,
      publishPort: "" as const,
      labels: { "hoist.app": "blog", "hoist.release": String(release.id) },
      volume: { name: appVolumeName(h.app), path: "/data" },
    };
    const own = await h.docker.createContainer(spec);
    await h.docker.startContainer(own);
    h.store.setReleaseState(release.id, "live", own);
    await h.docker.createContainer(spec);
    await expect(
      destroyApp(h.store, h.docker, h.app, async () => {}, h.caddy),
    ).rejects.toThrow("Stop containers using hoist-blog-data, then retry");
    expect(h.docker.running.has(own)).toBe(true);
    expect(h.docker.volumes.has(appVolumeName(h.app))).toBe(true);
    expect(destroyConfirmation({ ...h.app, volume_path: "/data" })).toContain(
      "volume hoist-blog-data (all data)",
    );
  } finally {
    await h.cleanup();
  }
});
