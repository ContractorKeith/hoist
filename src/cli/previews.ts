import { SqliteAppLocks } from "../adapters/app-lock";
import { Caddy } from "../adapters/caddy";
import { Docker } from "../adapters/docker";
import type {
  AppLocks,
  CaddyAdmin,
  DockerClient,
} from "../adapters/interfaces";
import { knownApp } from "../core/apps";
import { destroyPreview } from "../core/previews";
import { branchSlug } from "../core/validation";
import { dataRoot } from "../data";
import { caddySettings } from "../server";
import type { Store } from "../store/interface";
import { SqliteStore } from "../store/sqlite";

export function parsePreviews(args: string[]): void {
  if (
    args[0] === "previews:list" &&
    args[1] &&
    (args.length === 2 || (args.length === 3 && args[2] === "--json"))
  )
    return;
  if (
    args[0] === "previews:destroy" &&
    args.length === 3 &&
    args[1] &&
    args[2]
  ) {
    branchSlug(args[2]);
    return;
  }
  throw new Error(
    "Usage: hoist previews:list <app> [--json] | previews:destroy <app> <branch>",
  );
}

export interface PreviewContext {
  root: string;
  store: Store;
  docker?: DockerClient;
  caddy?: CaddyAdmin;
  locks: AppLocks;
  write: (message: string) => void;
}
export async function runPreviews(
  args: string[],
  context?: PreviewContext,
): Promise<void> {
  parsePreviews(args);
  const root = context?.root ?? dataRoot();
  const store = context?.store ?? new SqliteStore(root);
  const locks = context?.locks ?? new SqliteAppLocks(store);
  const write = context?.write ?? console.log;
  try {
    const name = args[1] ?? "";
    await locks.withLock(name, async () => {
      const app = knownApp(store, name);
      if (args[0] === "previews:list") {
        const rows = store.previews(app.id);
        write(
          args[2] === "--json"
            ? JSON.stringify(rows)
            : rows
                .map((row) => `${row.branch}\t${row.slug}\t${row.last_push_at}`)
                .join("\n"),
        );
      } else {
        await destroyPreview(
          root,
          store,
          context?.docker ?? new Docker(),
          context?.caddy ?? new Caddy(caddySettings(root).adminPort),
          app,
          store
            .previews(app.id)
            .find((row) => row.branch === args[2] || row.slug === args[2])
            ?.branch ??
            args[2] ??
            "",
        );
        write(`Destroyed preview ${name} ${args[2]}`);
      }
    });
  } finally {
    if (!context && store instanceof SqliteStore) store.close();
  }
}

export async function previewsCommand(
  root: string,
  store: Store,
  args: string[],
): Promise<void> {
  await runPreviews(args, {
    root,
    store,
    locks: new SqliteAppLocks(store),
    write: console.log,
  });
}
