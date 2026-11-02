import { join } from "node:path";
import { version } from "../../package.json";
import { Caddy } from "../adapters/caddy";
import { Docker } from "../adapters/docker";
import { checkHealth } from "../adapters/health";
import { wasBuildErrorLogged } from "../core/build";
import { appName } from "../core/validation";
import { dataRoot } from "../data";
import { parseDispatch } from "../git/dispatch";
import { receive } from "../git/hook";
import { caddySettings, serve } from "../server";
import { SqliteStore } from "../store/sqlite";
import { appsCommand, appsSet, parseCli } from "./apps";
import { configCommand } from "./config";
import { logsCommand } from "./logs";
import { releasesCommand } from "./releases";

const commands: Record<
  string,
  (
    root: string,
    store: SqliteStore,
    args: string[],
  ) => number | void | Promise<number> | Promise<void>
> = {
  "config:set": (_root, store, args) => configCommand(store, args),
  "config:unset": (_root, store, args) => configCommand(store, args),
  "config:list": (_root, store, args) => configCommand(store, args),
  releases: releasesCommand,
  logs: logsCommand,
  restart: releasesCommand,
  rollback: releasesCommand,
  "apps:create": appsCommand,
  "apps:list": appsCommand,
  "apps:info": appsCommand,
  "apps:destroy": appsCommand,
  "apps:set": (_root, store, args) => appsSet(store, args),
};

export { parseCli } from "./apps";

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
        if (!Object.hasOwn(commands, command.args[0] ?? ""))
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
    const handler = Object.hasOwn(commands, args[0] ?? "")
      ? commands[args[0] ?? ""]
      : undefined;
    if (handler) {
      const root = dataRoot();
      store = new SqliteStore(root);
      return (await handler(root, store, args)) ?? 0;
    }
    parseCli(args);
    console.log(version);
    return 0;
  } catch (error) {
    if (!wasBuildErrorLogged(error))
      console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    store?.close();
  }
}

if (import.meta.main) {
  const code = await run(Bun.argv.slice(2));
  // A blocked native stdout write can outlive the command's completed cleanup.
  if (code === 130 || code === 143) process.exit(code);
  process.exitCode = code;
}
