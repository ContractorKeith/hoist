import { expect, test } from "bun:test";
import { createApp, destroyApp } from "../../src/core/apps";
import { reserveRelease } from "../../src/core/build";
import {
  destroyPreview,
  previewHost,
  setMainBranch,
  sweepPreviews,
} from "../../src/core/previews";
import { reconcile } from "../../src/core/reconcile";
import { previewFixture } from "./preview-support";

for (const kind of ["fake", "sqlite"] as const) {
  test(`${kind}: converted old-main gets a fresh TTL; existing previews keep push time`, async () => {
    const h = await previewFixture(kind);
    try {
      const main = reserveRelease(h.store, h.app, "main", "a".repeat(40));
      h.store.completeRelease(main.id);
      h.store.setReleaseState(main.id, "live");
      reserveRelease(h.store, h.app, "other", "b".repeat(40));
      const pushed = h.store.previews(h.app.id)[0]?.last_push_at;
      const now = new Date(Date.now() + 21 * 86400000).toISOString();
      setMainBranch(h.store, h.app, "master", now);
      expect(
        h.store.previews(h.app.id).find((p) => p.branch === "main")
          ?.last_push_at,
      ).toBe(now);
      expect(
        h.store.previews(h.app.id).find((p) => p.branch === "other")
          ?.last_push_at,
      ).toBe(pushed);
      expect(h.store.app("blog")?.main_branch).toBe("master");
      await sweepPreviews(
        h.root,
        h.store,
        h.docker,
        h.caddy,
        h.locks,
        Date.parse(now) + 60000,
        7,
        () => {},
      );
      expect(
        h.store.releases(h.app.id).find((r) => r.branch === "main")?.status,
      ).toBe("live");
      setMainBranch(h.store, h.store.app("blog") ?? h.app, "main", now);
      expect(h.store.previews(h.app.id).some((p) => p.branch === "main")).toBe(
        false,
      );
    } finally {
      await h.cleanup();
    }
  });

  test(`${kind}: preview and app domains cannot claim each other's host`, async () => {
    const h = await previewFixture(kind);
    try {
      h.store.createApp("b", "feature.blog.test", "/");
      expect(() =>
        reserveRelease(h.store, h.app, "feature", "a".repeat(40)),
      ).toThrow("host feature.blog.test is already used by app b");
      expect(h.store.previews(h.app.id)).toEqual([]);
      reserveRelease(h.store, h.app, "other", "a".repeat(40));
      let provisioned = false;
      await expect(
        createApp(
          h.store,
          "c",
          "other.blog.test",
          "/",
          async () => {
            provisioned = true;
          },
          async () => {},
        ),
      ).rejects.toThrow("host other.blog.test is already used by app blog");
      await expect(
        createApp(
          h.store,
          "c",
          "blog.test",
          "/",
          async () => {},
          async () => {},
        ),
      ).rejects.toThrow("host blog.test is already used by app blog");
      expect(provisioned).toBe(false);
      let cleaned = false;
      await expect(
        createApp(
          h.store,
          "c",
          "raced.blog.test",
          "/",
          async () => {
            reserveRelease(h.store, h.app, "raced", "b".repeat(40));
          },
          async () => {
            cleaned = true;
          },
        ),
      ).rejects.toThrow("host raced.blog.test is already used by app blog");
      expect(cleaned).toBe(true);
      expect(h.store.app("c")).toBeNull();
      h.store.removePreview(h.app.id, "other");
      await expect(
        createApp(
          h.store,
          "c",
          "other.blog.test",
          "/",
          async () => {},
          async () => {},
        ),
      ).rejects.toThrow("host other.blog.test is already used by app blog");
      const legacy = h.store.createApp("legacy", "blog.test", "/");
      expect(() =>
        reserveRelease(h.store, legacy, "other", "a".repeat(40)),
      ).toThrow("already used by app blog");
    } finally {
      await h.cleanup();
    }
  });
}

test("failed teardown after route removal cannot be resurrected by reconcile", async () => {
  const h = await previewFixture();
  try {
    const row = reserveRelease(h.store, h.app, "feature", "a".repeat(40));
    h.store.completeRelease(row.id);
    h.store.setReleaseState(row.id, "live");
    h.docker.listImages = async () => {
      throw new Error("image lookup failed");
    };
    await expect(
      destroyPreview(h.root, h.store, h.docker, h.caddy, h.app, "feature"),
    ).rejects.toThrow("image lookup failed");
    expect(h.store.releases(h.app.id)[0]?.status).toBe("stopped");
    expect(h.caddy.calls.some((c) => c.method === "removeRoute")).toBe(true);
    await reconcile(h.store, h.docker, h.caddy, h.locks, async () => {});
    expect(h.docker.containers.size).toBe(0);
    expect(h.caddy.routes.has("feature.blog.test")).toBe(false);
  } finally {
    await h.cleanup();
  }
});

test("rowless route cleanup works and corrupt timestamps are skipped with a report", async () => {
  const h = await previewFixture();
  try {
    h.caddy.routes.set("missing.blog.test", "127.0.0.1:30000");
    await destroyPreview(h.root, h.store, h.docker, h.caddy, h.app, "missing");
    expect(h.caddy.routes.has("missing.blog.test")).toBe(false);
    reserveRelease(h.store, h.app, "corrupt", "a".repeat(40));
    h.store.upsertPreview({
      app_id: h.app.id,
      branch: "corrupt",
      slug: "corrupt",
      last_push_at: "broken",
    });
    const messages: string[] = [];
    await sweepPreviews(
      h.root,
      h.store,
      h.docker,
      h.caddy,
      h.locks,
      Date.now(),
      7,
      (m) => messages.push(m),
    );
    expect(h.store.previews(h.app.id)).toHaveLength(1);
    expect(messages).toEqual([
      "Preview sweep blog corrupt: invalid last_push_at; skipped",
    ]);
    expect(() => previewHost(h.app, "../bad")).toThrow("Invalid branch name");
  } finally {
    await h.cleanup();
  }
});

test("app destroy removes routes derived from release branches without preview rows", async () => {
  const h = await previewFixture();
  try {
    reserveRelease(h.store, h.app, "lost", "a".repeat(40));
    h.store.removePreview(h.app.id, "lost");
    h.store.stopBranchReleases(h.app.id, "lost");
    h.caddy.routes.set("lost.blog.test", "127.0.0.1:30000");
    await destroyApp(h.store, h.docker, h.app, async () => {}, h.caddy);
    expect(h.caddy.routes.size).toBe(0);
  } finally {
    await h.cleanup();
  }
});
