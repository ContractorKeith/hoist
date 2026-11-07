import { expect, test } from "bun:test";
import { setAppBranch } from "../../src/cli/app-branch";
import { reserveRelease } from "../../src/core/build";
import { cutover, recoverLive } from "../../src/core/cutover";
import { requirePreview } from "../../src/core/previews";
import { previewFixture } from "./preview-support";

const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("Missing fixture value");
  return value;
};
test("a live preview cannot be promoted to volume-backed production", async () => {
  const h = await previewFixture("sqlite");
  try {
    h.store.setVolumePath(h.app.id, "/data");
    const release = reserveRelease(h.store, h.app, "staging", "a".repeat(40));
    h.store.completeRelease(release.id);
    await cutover(
      h.store,
      h.docker,
      h.caddy,
      h.app,
      required(h.store.releases(h.app.id)[0]),
      null,
      async () => null,
      async () => {},
      undefined,
      "staging.blog.test",
    );
    await expect(
      setAppBranch(h.store, ["apps:set", "blog", "branch=staging"], {
        ...h,
        write: () => {},
        warn: () => {},
      }),
    ).rejects.toThrow("destroy the preview first");
    expect(h.store.app("blog")?.main_branch).toBeNull();
    expect(h.caddy.routes.has("blog.test")).toBe(false);
  } finally {
    await h.cleanup();
  }
});

test("renaming production keeps the mounted release until the new branch cuts over, including recovery", async () => {
  const h = await previewFixture("sqlite");
  try {
    h.store.setVolumePath(h.app.id, "/data");
    let app = required(h.store.app("blog"));
    const first = reserveRelease(h.store, app, "main", "a".repeat(40));
    h.store.completeRelease(first.id);
    await cutover(
      h.store,
      h.docker,
      h.caddy,
      app,
      required(h.store.releases(app.id)[0]),
      null,
      async () => null,
      async () => {},
    );
    const upstream = h.caddy.routes.get("blog.test");
    await setAppBranch(h.store, ["apps:set", "blog", "branch=trunk"], {
      ...h,
      write: () => {},
      warn: () => {},
    });
    app = required(h.store.app("blog"));
    expect(app).toMatchObject({
      main_branch: null,
      pending_main_branch: "trunk",
    });
    expect(h.caddy.routes.get("blog.test")).toBe(upstream);
    expect(h.caddy.routes.has("main.blog.test")).toBe(false);
    expect(h.store.previews(app.id)).toEqual([]);
    expect(() => requirePreview(h.store, app, "main")).toThrow();
    const live = required(
      h.store.releases(app.id).find((r) => r.status === "live"),
    );
    await h.docker.stopContainer(required(live.container_id));
    await recoverLive(h.store, h.docker, h.caddy, app, live, async () => {});
    const rejected = reserveRelease(h.store, app, "trunk", "c".repeat(40));
    h.store.completeRelease(rejected.id);
    await expect(
      cutover(
        h.store,
        h.docker,
        h.caddy,
        app,
        required(h.store.releases(app.id).find((r) => r.id === rejected.id)),
        null,
        async () => null,
        async () => {
          throw new Error("unhealthy");
        },
      ),
    ).rejects.toThrow("unhealthy");
    expect(h.store.app("blog")).toMatchObject({
      main_branch: null,
      pending_main_branch: "trunk",
    });
    expect(
      h.store
        .releases(app.id)
        .filter((r) => r.status === "live")
        .map((r) => r.branch),
    ).toEqual(["main"]);
    const next = reserveRelease(h.store, app, "trunk", "b".repeat(40));
    expect(h.store.previews(app.id)).toEqual([]);
    h.store.completeRelease(next.id);
    await cutover(
      h.store,
      h.docker,
      h.caddy,
      app,
      required(h.store.releases(app.id).find((r) => r.id === next.id)),
      null,
      async () => null,
      async () => {},
    );
    expect(h.store.app("blog")).toMatchObject({
      main_branch: "trunk",
      pending_main_branch: null,
      volume_path: "/data",
    });
    expect(
      h.store
        .releases(app.id)
        .filter((r) => r.status === "live")
        .map((r) => r.branch),
    ).toEqual(["trunk"]);
    expect(h.docker.running.size).toBe(1);
    expect(h.docker.volumes.size).toBe(1);
    await setAppBranch(h.store, ["apps:set", "blog", "branch=main"], {
      ...h,
      write: () => {},
      warn: () => {},
    });
    app = required(h.store.app("blog"));
    expect(app).toMatchObject({
      main_branch: "trunk",
      pending_main_branch: "main",
    });
    const back = reserveRelease(h.store, app, "main", "d".repeat(40));
    h.store.completeRelease(back.id);
    await cutover(
      h.store,
      h.docker,
      h.caddy,
      app,
      required(h.store.releases(app.id).find((r) => r.id === back.id)),
      null,
      async () => null,
      async () => {},
    );
    expect(h.store.app("blog")).toMatchObject({
      main_branch: "main",
      pending_main_branch: null,
    });
    expect(h.docker.running.size).toBe(1);
    expect(h.docker.volumes.size).toBe(1);
  } finally {
    await h.cleanup();
  }
});
