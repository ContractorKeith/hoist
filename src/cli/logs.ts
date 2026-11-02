import { Docker } from "../adapters/docker";
import { knownApp } from "../core/apps";
import { checkLogPath, liveLogs, releaseLogPath } from "../core/logs";
import { appName, branchSlug } from "../core/validation";
import type { App, Store } from "../store/interface";

const usage =
  "Usage: hoist logs <app> [-f] [-n <lines>] [--release vN] [--branch <b>]";
export function defaultBranch(_app?: App): string {
  return "main";
}

export function parseLogs(args: string[], app?: App) {
  const [name, ...rest] = args;
  const options = {
    app: appName(name ?? ""),
    branch: defaultBranch(app),
    lines: 100,
    follow: false,
    release: undefined as string | undefined,
  };
  const seen = new Set<string>();
  while (rest.length) {
    const flag = rest.shift() ?? "";
    if (seen.has(flag)) throw new Error(usage);
    seen.add(flag);
    if (flag === "-f") options.follow = true;
    else if (flag === "-n") {
      const value = rest.shift() ?? "";
      if (
        !/^[0-9]{1,5}$/.test(value) ||
        Number(value) < 1 ||
        Number(value) > 10000
      )
        throw new Error("Log lines must be between 1 and 10000");
      options.lines = Number(value);
    } else if (flag === "--branch") {
      options.branch = rest.shift() ?? "";
      branchSlug(options.branch);
    } else if (flag === "--release") {
      options.release = rest.shift() ?? "";
      if (!/^v[0-9]{1,9}$/.test(options.release))
        throw new Error("Invalid release; expected vN");
    } else throw new Error(usage);
  }
  if (options.release && (options.follow || seen.has("-n")))
    throw new Error("--release prints the complete file; omit -f and -n");
  return options;
}

// Race both file reads and writes so a blocked consumer cannot prevent cancellation.
export async function savedLogs(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  write: (chunk: Uint8Array) => Promise<unknown>,
): Promise<number> {
  const reader = stream.getReader();
  const stopped = Symbol("saved log interrupted");
  let stop: () => void = () => {};
  const aborted = new Promise<typeof stopped>((resolve) => {
    stop = () => resolve(stopped);
  });
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) stop();
    while (!signal.aborted) {
      const result = await Promise.race([reader.read(), aborted]);
      if (result === stopped || signal.aborted) break;
      if (result.done) return 0;
      if ((await Promise.race([write(result.value), aborted])) === stopped)
        break;
    }
    return signal.reason === 143 ? 143 : 130;
  } finally {
    signal.removeEventListener("abort", stop);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function logsCommand(
  root: string,
  store: Store,
  command: string[],
): Promise<number> {
  const args = command.slice(1);
  const options = parseLogs(args);
  const controller = new AbortController();
  const interrupt = () => controller.abort(130);
  const terminate = () => controller.abort(143);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    Object.assign(options, parseLogs(args, knownApp(store, options.app)));
    if (options.release) {
      const path = releaseLogPath(
        root,
        options.app,
        options.branch,
        options.release,
      );
      await checkLogPath(root, path);
      const file = Bun.file(path);
      if (!(await file.exists()))
        throw new Error(
          `No log file for ${options.app} branch ${options.branch} release ${options.release}.`,
        );
      return await savedLogs(file.stream(), controller.signal, (chunk) =>
        Bun.write(Bun.stdout, chunk),
      );
    } else {
      return await liveLogs(
        store,
        new Docker(),
        options,
        controller.signal,
        async (chunk) => {
          await Bun.write(Bun.stdout, chunk);
        },
      );
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
