import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAppLocks } from "../../src/adapters/app-lock";
import { FakeCaddy } from "../../src/adapters/fakes/caddy";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { SqliteStore } from "../../src/store/sqlite";

export async function previewFixture(kind: "fake" | "sqlite" = "fake") {
  const root = await mkdtemp(join(tmpdir(), "preview-review-"));
  const store = kind === "fake" ? new FakeStore() : new SqliteStore(root);
  const app = store.createApp("blog", "blog.test", "/");
  return {
    root,
    store,
    app,
    docker: new FakeDocker(),
    caddy: new FakeCaddy(),
    locks: new SqliteAppLocks(store),
    async cleanup() {
      if (store instanceof SqliteStore) store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
