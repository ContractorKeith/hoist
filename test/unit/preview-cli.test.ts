import { expect, test } from "bun:test";
import { appsSet } from "../../src/cli/apps";
import { parseCli } from "../../src/cli/index";
import { runPreviews } from "../../src/cli/previews";
import { reserveRelease } from "../../src/core/build";
import { cutover } from "../../src/core/cutover";
import { previewFixture } from "./preview-support";

test("preview CLI JSON reads and branch/slug teardown run while holding the app lease", async () => {
  const h = await previewFixture();
  const output: string[] = [];
  const context = {
    ...h,
    deleteRef: async () => {
      expect(h.store.lock("app:blog")).not.toBeNull();
    },
    write(message: string) {
      expect(h.store.lock("app:blog")).not.toBeNull();
      output.push(message);
    },
  };
  try {
    reserveRelease(h.store, h.app, "Feature/X-Y", "a".repeat(40));
    await runPreviews(["previews:list", "blog", "--json"], context);
    expect(JSON.parse(output[0] ?? "")).toEqual(h.store.previews(h.app.id));
    const remove = h.caddy.removeRoute.bind(h.caddy);
    h.caddy.removeRoute = async (host) => {
      expect(h.store.lock("app:blog")).not.toBeNull();
      expect(host).toBe("feature-x-y.blog.test");
      await remove(host);
    };
    await runPreviews(["previews:destroy", "blog", "feature-x-y"], context);
    expect(h.store.releases(h.app.id)).toEqual([]);
    reserveRelease(h.store, h.app, "Feature/X-Y", "b".repeat(40));
    await runPreviews(["previews:destroy", "blog", "Feature/X-Y"], context);
    expect(h.store.previews(h.app.id)).toEqual([]);
    expect(h.store.lock("app:blog")).toBeNull();
  } finally {
    await h.cleanup();
  }
});

test("apps:set moves old-main route before committing when new main has no live release", async () => {
  const h = await previewFixture();
  try {
    const row = reserveRelease(h.store, h.app, "main", "a".repeat(40));
    h.store.completeRelease(row.id);
    await cutover(
      h.store,
      h.docker,
      h.caddy,
      h.app,
      row,
      null,
      async () => null,
      async () => {},
    );
    const upsert = h.caddy.upsertRoute.bind(h.caddy),
      remove = h.caddy.removeRoute.bind(h.caddy);
    const beforeCommit = () => {
      expect(h.store.app("blog")?.main_branch).toBeUndefined();
      expect(h.store.lock("app:blog")).not.toBeNull();
    };
    h.caddy.upsertRoute = async (...args) => {
      beforeCommit();
      await upsert(...args);
    };
    h.caddy.removeRoute = async (host) => {
      beforeCommit();
      await remove(host);
    };
    await appsSet(h.store, ["apps:set", "blog", "branch=master"], {
      ...h,
      write: () => {},
      warn: () => {},
    });
    expect(h.store.app("blog")?.main_branch).toBe("master");
    expect(h.caddy.routes.has("main.blog.test")).toBe(true);
    expect(h.caddy.routes.has("blog.test")).toBe(false);
    expect(h.store.previews(h.app.id)[0]?.branch).toBe("main");
  } finally {
    await h.cleanup();
  }
});

test("apps:set warns for unreachable Caddy even without releases and rejects collisions before writes", async () => {
  const h = await previewFixture();
  const warnings: string[] = [];
  try {
    h.caddy.removeRoute = async () => {
      throw new Error("Caddy admin API not reachable");
    };
    const context = {
      ...h,
      write: () => {},
      warn: (m: string) => warnings.push(m),
    };
    await appsSet(h.store, ["apps:set", "blog", "branch=master"], context);
    expect(warnings).toEqual([
      "Caddy not reachable; routes are rebuilt from the store when hoist serve starts",
    ]);
    expect(h.store.app("blog")?.main_branch).toBe("master");
    const row = reserveRelease(
      h.store,
      h.store.app("blog") ?? h.app,
      "Feature/X",
      "a".repeat(40),
    );
    h.store.insertRelease({ ...row, branch: "feature-x" });
    const calls = h.caddy.calls.length;
    await expect(
      appsSet(h.store, ["apps:set", "blog", "branch=next"], context),
    ).rejects.toThrow("collides");
    expect(h.caddy.calls).toHaveLength(calls);
    expect(h.store.app("blog")?.main_branch).toBe("master");
    expect(() => parseCli([])).toThrow("apps:set");
    expect(() => parseCli([])).toThrow("previews:list");
    expect(() => parseCli([])).toThrow("previews:destroy");
  } finally {
    await h.cleanup();
  }
});
