import { lstat, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { DockerClient } from "../adapters/interfaces";
import type { Release, Store } from "../store/interface";
import { knownApp } from "./apps";
import { appName, branchSlug } from "./validation";

export function releaseLogPath(
  root: string,
  app: string,
  branch: string,
  release: string,
): string {
  appName(app);
  const slug = branchSlug(branch);
  if (!/^v[0-9]{1,9}$/.test(release))
    throw new Error("Invalid release; expected vN");
  return join(root, "releases", app, slug, release, "build.log");
}

// Refuse symlinks inside HOIST_DIR without creating a missing log file.
export async function checkLogPath(root: string, path: string): Promise<void> {
  let current = root;
  for (const part of relative(root, path).split("/")) {
    if (part === "..") throw new Error("Log path escapes HOIST_DIR");
    current = join(current, part);
    const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (entry?.isSymbolicLink())
      throw new Error("Release log path contains a symlink");
  }
}

// The prune caller must hold the app lease, keeping the live check and removal serialized.
export async function removeReleaseLogs(
  root: string,
  app: string,
  branch: string,
  number: number,
  store: Store,
): Promise<void> {
  const path = releaseLogPath(root, app, branch, `v${number}`);
  const owner = knownApp(store, app);
  if (
    store
      .releases(owner.id)
      .some(
        (row) =>
          branchSlug(row.branch) === branchSlug(branch) &&
          row.number === number &&
          row.status === "live",
      )
  )
    throw new Error(`Cannot remove live release v${number} logs`);
  await checkLogPath(root, path);
  await rm(dirname(path), { recursive: true, force: true });
}

export function stripCarriageReturns(chunk: Uint8Array): Uint8Array {
  return chunk.filter((byte) => byte !== 13);
}

export type LiveLogOptions = {
  app: string;
  branch: string;
  lines: number;
  follow: boolean;
};

// Only cancellation errors caused by our signal may be suppressed.
function cancelled(error: unknown, reason: unknown): boolean {
  if (error === reason) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return (
    error instanceof Error &&
    error.cause !== undefined &&
    cancelled(error.cause, reason)
  );
}

// Reattach when recovery changes a container; replacement releases end the session.
export async function liveLogs(
  store: Store,
  docker: DockerClient,
  options: LiveLogOptions,
  signal: AbortSignal,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<number> {
  const app = knownApp(store, appName(options.app));
  const slug = branchSlug(options.branch);
  if (
    !Number.isInteger(options.lines) ||
    options.lines < 1 ||
    options.lines > 10000
  )
    throw new Error("Log lines must be between 1 and 10000");
  const live = () =>
    store
      .releases(app.id)
      .find((row) => branchSlug(row.branch) === slug && row.status === "live");
  let release = live();
  if (!release?.container_id)
    throw new Error(`No live release for ${app.name} branch ${options.branch}`);
  while (!signal.aborted) {
    const attached: Release = { ...release };
    const controller = new AbortController();
    const transition = Symbol("log transition");
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let ended = false,
      closedPolls = 0;
    let next: Release = attached;
    let message = "",
      code = 0,
      pollError: unknown;
    const timer = options.follow
      ? setInterval(() => {
          try {
            const current = live();
            if (!current?.container_id) {
              message = `--- app ${app.name} has no live release ---`;
              code = 1;
            } else if (current.id !== attached.id)
              message = `--- release v${current.number} took over ---`;
            else if (current.container_id !== attached.container_id)
              next = current;
            else if (ended && ++closedPolls >= 2) {
              message = "--- container exited ---";
              code = 1;
            } else return;
            controller.abort(transition);
          } catch (error) {
            pollError = error;
            controller.abort(error);
          }
        }, 2000)
      : undefined;
    try {
      const stream = await docker.containerLogs(
        attached.container_id as string,
        options.follow,
        controller.signal,
        options.lines,
      );
      const reader = stream.getReader();
      const cancel = () => {
        void reader.cancel(controller.signal.reason).catch(() => {});
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        if (controller.signal.aborted) cancel();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            ended = true;
            break;
          }
          if (controller.signal.aborted) break;
          await write(stripCarriageReturns(value));
        }
        if (options.follow && !controller.signal.aborted)
          await new Promise<void>((resolve) =>
            controller.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch (error) {
      const expected =
        controller.signal.aborted &&
        (controller.signal.reason === transition ||
          (signal.aborted && controller.signal.reason === signal.reason));
      if (!expected || !cancelled(error, controller.signal.reason)) throw error;
    } finally {
      if (timer) clearInterval(timer);
      signal.removeEventListener("abort", abort);
    }
    if (pollError) throw pollError;
    if (signal.aborted) return 0;
    if (message) {
      await write(new TextEncoder().encode(`${message}\n`));
      return code;
    }
    if (!options.follow) return 0;
    release = next;
  }
  return 0;
}
