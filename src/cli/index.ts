import { join } from "node:path";
import { version } from "../../package.json";
import { SqliteAppLocks } from "../adapters/app-lock";
import { Caddy } from "../adapters/caddy";
import { Docker } from "../adapters/docker";
import { checkHealth } from "../adapters/health";
import { wasBuildErrorLogged } from "../core/build";
import { appName } from "../core/validation";
import { dataRoot } from "../data";
import { parseDispatch } from "../git/dispatch";
import { receive } from "../git/hook";
import { receiveDeleted } from "../git/post-receive";
import { caddySettings, serve } from "../server";
import { SqliteStore } from "../store/sqlite";
import { appsCommand, appsSet, parseCli } from "./apps";
import { configCommand } from "./config";
import { dashboardPassword } from "./dashboard";
import { doctor } from "./doctor";
import { logsCommand } from "./logs";
import { previewsCommand } from "./previews";
import { releasesCommand } from "./releases";

// Public CLI contract, shared with generated client help and README.
export const verbs = [
  "apps:create <name> [--domain <fqdn>] [--health-path </path>]",
  "apps:list [--json]",
  "apps:info <name> [--json]",
  "apps:destroy <name> [--force]",
  "apps:set <name> retention=N|branch=<name>",
  "config:set <name> K=V [K=V...] | <name> KEY --stdin",
  "config:unset <name> K",
  "config:list <name> [--reveal] [--json]",
  "releases <name> [--branch <b>] [--json]",
  "rollback <name> [vN]",
  "restart <name>",
  "logs <name> [-f] [--release vN] [--branch <b>] [-n <lines>]",
  "previews:list <name> [--json]",
  "previews:destroy <name> <branch>",
  "dashboard:set-password",
  "doctor [--json]",
  "version",
  "ssh-dispatch",
  "serve",
];
export const publicVerbs = verbs.filter(
  (verb) =>
    !["serve", "ssh-dispatch", "git-hook"].includes(verb.split(" ")[0] ?? ""),
);
export const usage = (entries = verbs) =>
  `Usage: hoist <verb>\n${entries.map((verb) => `  ${verb}`).join("\n")}`;

// Compare recreation against process start, before delay or lease acquisition.
const hookStartedAt = performance.timeOrigin;

const commands: Record<
  string,
  (
    root: string,
    store: SqliteStore,
    args: string[],
  ) => number | void | Promise<number> | Promise<void>
> = {
  // Doctor is here only for the ssh-dispatch allowlist; direct calls run above store setup.
  doctor: (_root, _store, args) => doctor(args),
  "config:set": (_root, store, args) => configCommand(store, args),
  "config:unset": (_root, store, args) => configCommand(store, args),
  "config:list": (_root, store, args) => configCommand(store, args),
  "dashboard:set-password": dashboardPassword,
  releases: releasesCommand,
  logs: logsCommand,
  restart: releasesCommand,
  rollback: releasesCommand,
  "apps:create": appsCommand,
  "apps:list": appsCommand,
  "apps:info": appsCommand,
  "apps:destroy": appsCommand,
  "apps:set": (_root, store, args) => appsSet(store, args),
  "previews:list": previewsCommand,
  "previews:destroy": previewsCommand,
};

export { parseCli } from "./apps";

export async function run(args: string[]): Promise<number> {
  let store: SqliteStore | undefined;
  try {
    if (args[0] === "--help" && args.length === 1) {
      console.log(usage());
      return 0;
    }
    if (args[0] === "doctor") return await doctor(args);
    if (args[0] === "serve" && args.length === 1) {
      await serve();
      return 0;
    }
    if (args[0] === "ssh-dispatch" && args.length === 1) {
      const command = parseDispatch(process.env.SSH_ORIGINAL_COMMAND ?? "");
      if (command.kind === "cli") {
        const [verb] = command.args;
        if (verb === "--help" && command.args.length === 1) {
          console.log(usage(publicVerbs));
          return 0;
        }
        if (
          (!Object.hasOwn(commands, verb ?? "") && verb !== "version") ||
          (["--help", "version"].includes(verb ?? "") &&
            command.args.length !== 1)
        )
          throw new Error(usage(publicVerbs));
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
      ["pre-receive", "post-receive"].includes(args[1] ?? "") &&
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
        const input = new TextDecoder().decode(Buffer.concat(chunks));
        const docker = new Docker(),
          caddy = new Caddy(caddySettings(root).adminPort);
        if (args[1] === "post-receive" && process.env.HOIST_E2E !== undefined) {
          const delay = Number(process.env.HOIST_TEST_HOOK_DELAY_MS ?? 0);
          if (!Number.isInteger(delay) || delay < 0 || delay > 60000)
            throw new Error("Invalid test hook delay");
          if (delay) {
            console.error("hoist: delaying post-receive for race test");
            await Bun.sleep(delay);
          }
        }
        if (args[1] === "post-receive")
          await receiveDeleted(
            root,
            store,
            docker,
            caddy,
            new SqliteAppLocks(store),
            app,
            input,
            controller.signal,
            hookStartedAt,
          );
        else
          await receive(root, store, docker, app, input, controller.signal, {
            caddy,
            health: checkHealth,
          });
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
    if (args[0] !== "version") throw new Error(usage());
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
