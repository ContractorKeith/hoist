import { open } from "node:fs/promises";
import { join } from "node:path";
import { SqliteAppLocks } from "../adapters/app-lock";
import { Caddy } from "../adapters/caddy";
import { Docker } from "../adapters/docker";
import { checkHealth } from "../adapters/health";
import { knownApp } from "../core/apps";
import { cutover } from "../core/cutover";
import { removeReleaseLogs } from "../core/logs";
import { prune } from "../core/retention";
import { copyRelease } from "../core/rollback";
import { appName, branchSlug } from "../core/validation";
import { privatePath } from "../data";
import { caddySettings } from "../server";
import type { Store } from "../store/interface";

export async function releasesCommand(
  root: string,
  store: Store,
  args: string[],
  signal?: AbortSignal,
): Promise<void> {
  const [verb, name, ...rest] = args;
  const app = knownApp(store, appName(name ?? ""));
  if (verb === "releases") {
    let json = false;
    let branch: string | undefined;
    const seen = new Set<string>();
    while (rest.length) {
      const flag = rest.shift() ?? "";
      if (seen.has(flag)) throw new Error("Duplicate releases option");
      seen.add(flag);
      if (flag === "--json") json = true;
      else if (flag === "--branch") branch = branchSlug(rest.shift() ?? "");
      else
        throw new Error("Usage: hoist releases <app> [--branch <b>] [--json]");
    }
    const rows = store
      .releases(app.id)
      .filter(
        (row) => branch === undefined || branchSlug(row.branch) === branch,
      )
      .map((row) => ({
        number: row.number,
        branch: row.branch,
        status: row.status,
        sha12: row.git_sha.slice(0, 12),
        image: row.image,
        created_at: row.created_at,
        live: row.status === "live",
        pruned_at: row.pruned_at,
      }));
    console.log(
      json
        ? JSON.stringify(rows)
        : rows
            .map(
              (row) =>
                `v${row.number}\t${row.branch}\t${row.status}\t${row.sha12}\t${row.image}\t${row.created_at}\t${row.live ? "live" : ""}`,
            )
            .join("\n"),
    );
    return;
  }
  if (rest.length > (verb === "rollback" ? 1 : 0))
    throw new Error(
      `Usage: hoist ${verb} <app>${verb === "rollback" ? " [vN]" : ""}`,
    );
  await new SqliteAppLocks(store).withLock(
    app.name,
    async () => {
      const app = knownApp(store, name ?? "");
      const docker = new Docker();
      const release = await copyRelease(
        store,
        docker,
        app,
        verb === "restart",
        rest[0],
      );
      const path = privatePath(
        join(
          root,
          "releases",
          app.name,
          branchSlug(release.branch),
          `v${release.number}`,
          "build.log",
        ),
        false,
        false,
        root,
      );
      const file = await open(path, "a", 0o600);
      try {
        await cutover(
          store,
          docker,
          new Caddy(caddySettings(root).adminPort),
          app,
          release,
          null,
          async () => null,
          checkHealth,
          async (line) => {
            await file.writeFile(`${line}\n`);
            console.log(line);
          },
        );
        await prune(
          store,
          docker,
          app,
          (row) =>
            removeReleaseLogs(root, app.name, row.branch, row.number, store),
          async (message) => {
            await file.writeFile(`${message}\n`);
          },
          release.branch,
        );
      } finally {
        await file.close();
      }
    },
    signal,
  );
}
