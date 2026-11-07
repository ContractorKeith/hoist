import { rm } from "node:fs/promises";
import { join } from "node:path";
import { SqliteAppLocks } from "../adapters/app-lock";
import { Caddy } from "../adapters/caddy";
import { Docker } from "../adapters/docker";
import { hostName } from "../adapters/validation";
import { createApp, destroyApp, knownApp } from "../core/apps";
import { appName, healthPath } from "../core/validation";
import { appVolumeName, setVolume, volumePath } from "../core/volumes";
import { createRepo } from "../git/repository";
import { caddySettings } from "../server";
import type { Store } from "../store/interface";
import { type AppSetContext, setAppBranch } from "./app-branch";

export function appsSet(
  store: Store,
  args: string[],
  context?: AppSetContext,
): void | Promise<void> {
  const [, name, setting, ...extra] = args;
  const app = knownApp(store, appName(name ?? ""));
  if (!extra.length && setting?.startsWith("branch="))
    return setAppBranch(store, args, context);
  if (!extra.length && setting?.startsWith("volume=")) {
    const path = volumePath(setting.slice(7));
    return new SqliteAppLocks(store).withLock(app.name, async () => {
      setVolume(store, knownApp(store, app.name), path);
      console.log("saved; takes effect at the next release");
    });
  }
  const match = /^retention=([1-9]|[1-9][0-9]|100)$/.exec(setting ?? "");
  if (extra.length || !match)
    throw new Error(
      "Usage: hoist apps:set <app> retention=N (1..100) | branch=<name> | volume=</path>",
    );
  store.setRetention(app.id, Number(match[1]));
  console.log("saved");
}

const usage =
  "Usage: hoist apps:create <name> [--domain <fqdn>] [--health-path </path>] [--volume </path>] | apps:list [--json] | apps:info <name> [--json] | apps:destroy <name> [--force] [--delete-volume] | logs <app> [-f] [-n <lines>] [--release vN] [--branch <b>] | apps:set <app> retention=N|branch=<name>|volume=</path> | previews:list <app> [--json] | previews:destroy <app> <branch> | version";

export function parseCli(args: string[]): {
  verb: string;
  name?: string;
  domain?: string;
  health?: string;
  volume?: string;
  json: boolean;
  force: boolean;
  deleteVolume: boolean;
} {
  const [verb, ...rest] = args;
  if (
    !verb ||
    ![
      "version",
      "apps:create",
      "apps:list",
      "apps:info",
      "apps:destroy",
    ].includes(verb)
  )
    throw new Error(usage);
  const result = {
    verb,
    name: undefined as string | undefined,
    domain: undefined as string | undefined,
    health: undefined as string | undefined,
    volume: undefined as string | undefined,
    json: false,
    force: false,
    deleteVolume: false,
  };
  if (verb !== "version" && verb !== "apps:list") {
    const name = rest.shift() ?? "";
    if (name.startsWith("--")) throw new Error(usage);
    result.name = appName(name);
  }
  const seen = new Set<string>();
  while (rest.length) {
    const flag = rest.shift() ?? "";
    if (seen.has(flag)) throw new Error(usage);
    seen.add(flag);
    if (flag === "--json" && ["apps:list", "apps:info"].includes(verb))
      result.json = true;
    else if (flag === "--force" && verb === "apps:destroy") result.force = true;
    else if (flag === "--delete-volume" && verb === "apps:destroy")
      result.deleteVolume = true;
    else if (flag === "--domain" && verb === "apps:create") {
      result.domain = (rest.shift() ?? "").toLowerCase();
      hostName(result.domain);
    } else if (flag === "--health-path" && verb === "apps:create")
      result.health = healthPath(rest.shift() ?? "");
    else if (flag === "--volume" && verb === "apps:create")
      result.volume = volumePath(rest.shift() ?? "");
    else throw new Error(usage);
  }
  return result;
}

export async function appsCommand(
  root: string,
  store: Store,
  args: string[],
): Promise<number> {
  const command = parseCli(args);
  if (command.verb === "apps:list") {
    const apps = store.apps();
    console.log(
      command.json
        ? JSON.stringify(apps)
        : apps.map((a) => `${a.name}\t${a.domain}`).join("\n"),
    );
    return 0;
  }
  const name = appName(command.name ?? "");
  if (command.verb === "apps:create") {
    if (!command.domain && !process.env.HOIST_DOMAIN)
      throw new Error(
        "HOIST_DOMAIN is not set; pass --domain or set HOIST_DOMAIN",
      );
    const domain = command.domain ?? `${name}.${process.env.HOIST_DOMAIN}`;
    hostName(domain);
    await createApp(
      store,
      name,
      domain,
      command.health ?? "/",
      () => createRepo(root, name),
      () =>
        rm(join(root, "repos", `${name}.git`), {
          recursive: true,
          force: true,
        }),
      command.volume,
    );
    console.log(
      `Created ${name} (${domain}); git remote add hoist hoist@<server>:${name}.git`,
    );
    return 0;
  }
  const app = knownApp(store, name);
  if (command.verb === "apps:info") {
    const info = {
      ...app,
      volume_name: app.volume_path ? appVolumeName(app) : null,
      releases: store.releases(app.id),
    };
    console.log(
      command.json ? JSON.stringify(info) : JSON.stringify(info, null, 2),
    );
    return 0;
  }
  if (!command.force) {
    if (!process.stdin.isTTY)
      throw new Error("apps:destroy requires --force without a TTY");
    if (prompt(`Destroy ${name}? Type ${name} to confirm:`) !== name)
      throw new Error("Destroy cancelled");
  }
  const lease = await new SqliteAppLocks(store).acquire(`app:${name}`, {
    failFast: true,
  });
  try {
    await destroyApp(
      store,
      new Docker(),
      app,
      async () => {
        await rm(join(root, "repos", `${name}.git`), {
          recursive: true,
          force: true,
        });
        await rm(join(root, "releases", name), {
          recursive: true,
          force: true,
        });
      },
      new Caddy(caddySettings(root).adminPort),
      console.error,
      command.deleteVolume,
    );
  } finally {
    lease.release();
  }
  console.log(`Destroyed ${name}`);
  return 0;
}
