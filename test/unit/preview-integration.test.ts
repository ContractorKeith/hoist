import { expect, spyOn, test } from "bun:test";
import { appsSet } from "../../src/cli/apps";
import { defaultBranch, parseLogs } from "../../src/cli/logs";
import { releasesCommand } from "../../src/cli/releases";
import { reserveRelease } from "../../src/core/build";
import { cutover } from "../../src/core/cutover";
import { removeReleaseLogs } from "../../src/core/logs";
import { destroyPreview, setMainBranch } from "../../src/core/previews";
import { prune } from "../../src/core/retention";
import { copyRelease } from "../../src/core/rollback";
import { encrypt } from "../../src/core/secrets";
import { previewFixture } from "./preview-support";

test("configured main branch drives saved/live log defaults, rollback and restart snapshots", async () => {
  const h = await previewFixture();
  try {
    setMainBranch(h.store, h.app, "stable");
    const app = h.store.app("blog") ?? h.app;
    expect(defaultBranch(app)).toBe("stable");
    expect(parseLogs(["blog"], app).branch).toBe("stable");
    expect(parseLogs(["blog", "--branch", "Feature/X-Y"], app).branch).toBe(
      "Feature/X-Y",
    );
    const key = await h.store.secretKey();
    h.store.setConfig(
      app.id,
      "LABEL",
      await encrypt(key, "first", app.id, "LABEL"),
    );
    const first = reserveRelease(h.store, app, "stable", "a".repeat(40));
    h.store.completeRelease(first.id);
    h.store.setReleaseState(first.id, "live");
    h.store.setReleaseState(first.id, "stopped");
    h.store.setConfig(
      app.id,
      "LABEL",
      await encrypt(key, "second", app.id, "LABEL"),
    );
    const second = reserveRelease(h.store, app, "stable", "b".repeat(40));
    h.store.completeRelease(second.id);
    h.store.setReleaseState(second.id, "live");
    reserveRelease(h.store, app, "main", "c".repeat(40));
    const rollback = await copyRelease(h.store, h.docker, app, false, "v1");
    expect(rollback.branch).toBe("stable");
    expect(rollback.number).toBe(3);
    expect(rollback.config_json).toBe(first.config_json);
    const restart = await copyRelease(h.store, h.docker, app, true);
    expect(restart.branch).toBe("stable");
    expect(restart.number).toBe(4);
    expect(restart.config_json).toBe(second.config_json);
    const preview = reserveRelease(h.store, app, "feature", "d".repeat(40));
    h.store.completeRelease(preview.id);
    await cutover(
      h.store,
      h.docker,
      h.caddy,
      app,
      preview,
      null,
      async () => null,
      async () => {},
      async () => {},
      "feature.blog.test",
    );
    const spec = h.docker.calls.find((c) => c.method === "createContainer")
      ?.args[0] as { config: Record<string, string> };
    expect(spec.config.LABEL).toBe("second");
  } finally {
    await h.cleanup();
  }
});

test("release listing filters by slug and apps:set keeps the retention dispatcher", async () => {
  const h = await previewFixture();
  const printed = spyOn(console, "log").mockImplementation(() => {});
  try {
    reserveRelease(h.store, h.app, "main", "a".repeat(40));
    reserveRelease(h.store, h.app, "Feature/X-Y", "b".repeat(40));
    appsSet(h.store, ["apps:set", "blog", "retention=2"]);
    expect(h.store.app("blog")?.retention).toBe(2);
    await releasesCommand(h.root, h.store, [
      "releases",
      "blog",
      "--json",
      "--branch",
      "feature-x-y",
    ]);
    expect(JSON.parse(String(printed.mock.calls.at(-1)?.[0]))).toMatchObject([
      { branch: "Feature/X-Y", number: 1 },
    ]);
    await expect(
      releasesCommand(h.root, h.store, [
        "releases",
        "blog",
        "--branch",
        "../bad",
      ]),
    ).rejects.toThrow();
  } finally {
    printed.mockRestore();
    await h.cleanup();
  }
});

test("branch pruning preserves other chains and preview teardown uses stopped release log cleanup", async () => {
  const h = await previewFixture();
  try {
    h.store.setRetention(h.app.id, 1);
    for (const branch of ["main", "feature"]) {
      for (let index = 0; index < 2; index++) {
        const row = reserveRelease(h.store, h.app, branch, "a".repeat(40));
        h.store.completeRelease(row.id);
        h.store.setReleaseState(row.id, "live");
        h.store.setReleaseState(row.id, "stopped");
        h.docker.images.set(row.image, {});
      }
    }
    const removed: string[] = [];
    await prune(
      h.store,
      h.docker,
      h.app,
      async (r) => {
        removed.push(`${r.branch}/v${r.number}`);
      },
      async () => {},
      "feature",
    );
    expect(removed).toEqual(["feature/v1"]);
    expect(
      h.store
        .releases(h.app.id)
        .filter((r) => r.pruned_at)
        .map((r) => r.branch),
    ).toEqual(["feature"]);
    const live = reserveRelease(h.store, h.app, "feature", "b".repeat(40));
    h.store.completeRelease(live.id);
    h.store.setReleaseState(live.id, "live");
    await expect(
      removeReleaseLogs(h.root, h.app.name, "feature", live.number, h.store),
    ).rejects.toThrow("live release");
    await destroyPreview(h.root, h.store, h.docker, h.caddy, h.app, "feature");
    expect(h.store.releases(h.app.id).map((r) => r.branch)).toEqual([
      "main",
      "main",
    ]);
  } finally {
    await h.cleanup();
  }
});
