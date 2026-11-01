import { rm } from "node:fs/promises";
import { join } from "node:path";
import { version } from "../../package.json";
import { Caddy } from "../adapters/caddy";
import { Docker } from "../adapters/docker";
import { checkHealth } from "../adapters/health";
import { hostName } from "../adapters/validation";
import { createApp, destroyApp, knownApp } from "../core/apps";
import { wasBuildErrorLogged } from "../core/build";
import { appName, healthPath } from "../core/validation";
import { dataRoot } from "../data";
import { parseDispatch } from "../git/dispatch";
import { receive } from "../git/hook";
import { createRepo } from "../git/repository";
import { caddySettings, serve } from "../server";
import { SqliteStore } from "../store/sqlite";

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

export async function run(args: string[]): Promise<number> {
  let store: SqliteStore | undefined;
  try {
    if (args[0] === "serve" && args.length === 1) {
      await serve();
      return 0;
    }
    if (args[0] === "ssh-dispatch" && args.length === 1) {
      const command = parseDispatch(process.env.SSH_ORIGINAL_COMMAND ?? "");
      if (command.kind === "cli") {
        parseCli(command.args); // Internal entry points are never exposed over SSH.
        return run(command.args);
      }
      const root = dataRoot();
      store = new SqliteStore(root);
      if (!store.app(command.app))
        throw new Error(
          `Unknown app ${command.app}; run hoist apps:create ${command.app} first`,
        );
      const child = Bun.spawn(
        ["git", "receive-pack", join(root, "repos", `${command.app}.git`)],
        { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
      );
      return await child.exited;
    }
    if (
      args[0] === "git-hook" &&
      args[1] === "pre-receive" &&
      args.length === 3
    ) {
      const name = appName(args[2] ?? "");
      const root = dataRoot();
      store = new SqliteStore(root);
      const app = store.app(name);
      if (!app)
        throw new Error(`Unknown app; run hoist apps:create ${name} first`);
      const controller = new AbortController();
      const abort = () => controller.abort(new Error("Build aborted"));
      process.on("SIGTERM", abort);
      const disconnected = () => {};
      process.on("SIGHUP", disconnected);
      process.on("SIGPIPE", disconnected);
      try {
        const chunks: Uint8Array[] = [];
        let length = 0;
        for await (const chunk of Bun.stdin.stream()) {
          length += chunk.length;
          if (length > 1024 * 1024) throw new Error("Ref input too large");
          chunks.push(chunk);
        }
        await receive(
          root,
          store,
          new Docker(),
          app,
          new TextDecoder().decode(Buffer.concat(chunks)),
          controller.signal,
          {
            caddy: new Caddy(caddySettings(root).adminPort),
            health: checkHealth,
          },
        );
      } finally {
        process.off("SIGTERM", abort);
        process.off("SIGHUP", disconnected);
        process.off("SIGPIPE", disconnected);
      }
      return 0;
    }
    const command = parseCli(args);
    if (command.verb === "version") {
      console.log(version);
      return 0;
    }
    const root = dataRoot();
    store = new SqliteStore(root);
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
  } catch (error) {
    if (!wasBuildErrorLogged(error))
      console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    store?.close();
  }
}

if (import.meta.main) process.exitCode = await run(Bun.argv.slice(2));
