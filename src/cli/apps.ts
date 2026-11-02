import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Caddy } from "../adapters/caddy";
import { Docker } from "../adapters/docker";
import { hostName } from "../adapters/validation";
import { createApp, destroyApp, knownApp } from "../core/apps";
import { appName, healthPath } from "../core/validation";
import { createRepo } from "../git/repository";
import { caddySettings } from "../server";
import type { Store } from "../store/interface";

export function appsSet(store: Store, args: string[]): void {
  const [, name, setting, ...extra] = args;
  const app = knownApp(store, appName(name ?? ""));
  if (extra.length || !/^retention=([1-9]|[1-9][0-9]|100)$/.test(setting ?? ""))
    throw new Error("Usage: hoist apps:set <app> retention=N (1..100)");
  store.setRetention(app.id, Number(setting?.slice(10)));
  console.log("saved");
}

const usage =
  "Usage: hoist apps:create <name> [--domain <fqdn>] [--health-path </path>] | apps:list [--json] | apps:info <name> [--json] | apps:destroy <name> [--force] | version";

export function parseCli(args: string[]): {
  verb: string;
  name?: string;
  domain?: string;
  health?: string;
  json: boolean;
  force: boolean;
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
    json: false,
    force: false,
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
    else if (flag === "--domain" && verb === "apps:create") {
      result.domain = (rest.shift() ?? "").toLowerCase();
      hostName(result.domain);
    } else if (flag === "--health-path" && verb === "apps:create")
      result.health = healthPath(rest.shift() ?? "");
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
    );
    console.log(
      `Created ${name} (${domain}); git remote add hoist hoist@<server>:${name}.git`,
    );
    return 0;
  }
  const app = knownApp(store, name);
  if (command.verb === "apps:info") {
    const info = { ...app, releases: store.releases(app.id) };
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
  );
  console.log(`Destroyed ${name}`);
  return 0;
}
