import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { DashboardStore } from "../../src/store/dashboard";
import { SqliteStore } from "../../src/store/sqlite";
import { Actions } from "../../src/web/actions";
import { dashboard } from "../../src/web/router";

export async function setup(
  run: (args: string[]) => Promise<void> = async () => {},
) {
  const root = await mkdtemp(join(tmpdir(), "dashboard-"));
  const store = new SqliteStore(root),
    docker = new FakeDocker();
  const db = new DashboardStore(store.db),
    actions = new Actions(run);
  const handle = dashboard(store, docker, actions);
  return {
    root,
    store,
    docker,
    db,
    actions,
    handle,
    async close() {
      await actions.finish();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export const request = (
  path: string,
  cookie = "",
  form?: Record<string, string>,
  ip = "127.0.0.1",
) =>
  new Request(`https://hoist.test${path}`, {
    method: form ? "POST" : "GET",
    headers: { cookie, "x-forwarded-for": ip },
    body: form ? new URLSearchParams(form) : undefined,
  });
export const csrf = (html: string) =>
  /name="csrf" value="([a-f0-9]+)"/.exec(html)?.[1] ?? "";
