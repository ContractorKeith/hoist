import { expect, test } from "bun:test";
import { runPreviews } from "../../src/cli/previews";
import { reserveRelease } from "../../src/core/build";
import { destroyPreview } from "../../src/core/previews";
import { receive } from "../../src/git/hook";
import { receiveDeleted } from "../../src/git/post-receive";
import { previewFixture } from "./preview-support";

const sha = "a".repeat(40),
  zero = "0".repeat(40);
const deleted = (branch: string) => `${sha} ${zero} refs/heads/${branch}\n`;

test("unowned preview CLI and deletion push cannot remove another app's route", async () => {
  const h = await previewFixture();
  const output: string[] = [],
    refs: string[] = [];
  try {
    h.store.createApp("b", "blocked.blog.test", "/");
    h.caddy.routes.set("blocked.blog.test", "127.0.0.1:30000");
    await expect(
      runPreviews(["previews:destroy", "blog", "blocked"], {
        ...h,
        write: (m) => output.push(m),
        deleteRef: async (branch) => {
          refs.push(branch);
        },
      }),
    ).rejects.toThrow("no preview blocked for blog");
    await receiveDeleted(
      h.root,
      h.store,
      h.docker,
      h.caddy,
      h.locks,
      h.app,
      deleted("blocked"),
      new AbortController().signal,
      Date.now(),
      {
        head: async () => {
          throw new Error("must not inspect an unowned ref");
        },
        objectType: async () => "commit",
      },
      (m) => output.push(m),
    );
    expect(output).toEqual([
      "hoist: blocked had no preview; nothing to tear down",
    ]);
    expect(refs).toEqual([]);
    expect(h.docker.calls).toEqual([]);
    expect(h.caddy.calls).toEqual([]);
    expect(h.caddy.routes.get("blocked.blog.test")).toBe("127.0.0.1:30000");
    // A release alone still proves ownership after partial metadata loss.
    const owned = reserveRelease(h.store, h.app, "owned", sha);
    h.store.stopBranchReleases(h.app.id, "owned");
    h.store.removePreview(h.app.id, "owned");
    await destroyPreview(h.root, h.store, h.docker, h.caddy, h.app, "owned");
    expect(h.store.releases(h.app.id).some((r) => r.id === owned.id)).toBe(
      false,
    );
  } finally {
    await h.cleanup();
  }
});

test("post-receive keeps a newly reserved release even while its ref is absent", async () => {
  const h = await previewFixture();
  const output: string[] = [];
  try {
    const startedAt = Date.now() - 1000;
    const row = reserveRelease(h.store, h.app, "feature", "b".repeat(40));
    h.store.completeRelease(row.id);
    h.store.setReleaseState(row.id, "live");
    h.caddy.routes.set("feature.blog.test", "127.0.0.1:30000");
    await receiveDeleted(
      h.root,
      h.store,
      h.docker,
      h.caddy,
      h.locks,
      h.app,
      deleted("feature"),
      new AbortController().signal,
      startedAt,
      { head: async () => null, objectType: async () => "commit" },
      (m) => output.push(m),
    );
    expect(output).toEqual([
      "branch feature was recreated after this deletion; keeping it",
    ]);
    expect(row.status).toBe("live");
    expect(h.docker.calls).toEqual([]);
    expect(h.caddy.routes.has("feature.blog.test")).toBe(true);
  } finally {
    await h.cleanup();
  }
});

test("post-receive continues a deletion batch and reports only previews left behind", async () => {
  const h = await previewFixture();
  const output: string[] = [];
  try {
    for (const branch of ["abroken", "zhealthy"]) {
      const row = reserveRelease(h.store, h.app, branch, sha);
      row.created_at = "2020-01-01T00:00:00Z";
      h.store.completeRelease(row.id);
      h.store.setReleaseState(row.id, "live");
      h.caddy.routes.set(`${branch}.blog.test`, "127.0.0.1:30000");
    }
    const remove = h.caddy.removeRoute.bind(h.caddy);
    h.caddy.removeRoute = async (host) => {
      if (host.startsWith("abroken.")) throw new Error("Caddy failure");
      await remove(host);
    };
    await expect(
      receiveDeleted(
        h.root,
        h.store,
        h.docker,
        h.caddy,
        h.locks,
        h.app,
        deleted("abroken") + deleted("zhealthy"),
        new AbortController().signal,
        Date.now(),
        { head: async () => null, objectType: async () => "commit" },
        (m) => output.push(m),
      ),
    ).rejects.toThrow("previews left behind: abroken");
    expect(h.store.previews(h.app.id).map((p) => p.branch)).toEqual([
      "abroken",
    ]);
    expect(h.store.releases(h.app.id).map((r) => [r.branch, r.status])).toEqual(
      [["abroken", "stopped"]],
    );
    expect(h.caddy.routes.has("zhealthy.blog.test")).toBe(false);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("teardown abroken failed");
  } finally {
    await h.cleanup();
  }
});

test("one update may accompany batched deletions", async () => {
  const h = await previewFixture();
  try {
    await expect(
      receive(
        h.root,
        h.store,
        h.docker,
        h.app,
        `${zero} ${sha} refs/heads/feature\n${deleted("old-one")}${deleted("old-two")}`,
        new AbortController().signal,
        { caddy: h.caddy, health: async () => {} },
        undefined,
        { objectType: async () => "blob", head: async () => null },
      ),
    ).rejects.toThrow("pushed object is not a commit");
    expect(h.store.releases(h.app.id)).toEqual([]);
  } finally {
    await h.cleanup();
  }
});

test("explicit destruction records stopped state before deleting its Git ref", async () => {
  const h = await previewFixture();
  try {
    const row = reserveRelease(h.store, h.app, "feature", sha);
    h.store.completeRelease(row.id);
    h.store.setReleaseState(row.id, "live");
    await expect(
      runPreviews(["previews:destroy", "blog", "feature"], {
        ...h,
        write: () => {},
        deleteRef: async () => {
          expect(h.store.lock("app:blog")).not.toBeNull();
          expect(row.status).toBe("stopped");
          throw new Error("Git ref is readonly");
        },
      }),
    ).rejects.toThrow("Git ref is readonly");
    expect(row.status).toBe("stopped");
    expect(h.store.previews(h.app.id)).toHaveLength(1);
    expect(h.docker.calls).toEqual([]);
    expect(h.caddy.calls).toEqual([]);
  } finally {
    await h.cleanup();
  }
});
