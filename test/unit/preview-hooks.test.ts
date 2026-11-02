import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { reserveRelease } from "../../src/core/build";
import { receive } from "../../src/git/hook";
import { receiveDeleted } from "../../src/git/post-receive";
import { createRepo } from "../../src/git/repository";
import { previewFixture } from "./preview-support";

test("pre-receive preserves a deletion's resources; post-receive tears down only committed deletions", async () => {
  const h = await previewFixture();
  try {
    const sha = "a".repeat(40),
      input = `${sha} ${"0".repeat(40)} refs/heads/feature\n`;
    reserveRelease(h.store, h.app, "feature", sha);
    await receive(
      h.root,
      h.store,
      h.docker,
      h.app,
      input,
      new AbortController().signal,
      { caddy: h.caddy, health: async () => {} },
    );
    expect(h.store.previews(h.app.id)).toHaveLength(1);
    expect(h.docker.calls).toEqual([]);
    const post = (head: string | null) =>
      receiveDeleted(
        h.root,
        h.store,
        h.docker,
        h.caddy,
        h.locks,
        h.app,
        input,
        new AbortController().signal,
        { head: async () => head, objectType: async () => "commit" },
      );
    // Git rejected the deletion, or a later push recreated the ref.
    await post(sha);
    expect(h.store.previews(h.app.id)).toHaveLength(1);
    h.caddy.removeRoute = async (host) => {
      expect(h.store.lock("app:blog")).not.toBeNull();
      expect(host).toBe("feature.blog.test");
    };
    await post(null);
    expect(h.store.previews(h.app.id)).toEqual([]);
    expect(h.store.releases(h.app.id)).toEqual([]);
    await createRepo(h.root, "hooks");
    for (const hook of ["pre-receive", "post-receive"])
      expect(
        await readFile(join(h.root, "repos/hooks.git/hooks", hook), "utf8"),
      ).toContain(`git-hook ${hook} 'hooks'`);
  } finally {
    await h.cleanup();
  }
});
