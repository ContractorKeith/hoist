import { lstat, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { DockerClient } from "../adapters/interfaces";
import type { Store } from "../store/interface";
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
          row.branch === branch &&
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

// Runtime logs stay as bytes; M6 can reuse this with its own output sink and signal.
export async function liveLogs(
  store: Store,
  docker: DockerClient,
  options: LiveLogOptions,
  signal: AbortSignal,
  write: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const app = knownApp(store, appName(options.app));
  branchSlug(options.branch);
  if (
    !Number.isInteger(options.lines) ||
    options.lines < 1 ||
    options.lines > 10000
  )
    throw new Error("Log lines must be between 1 and 10000");
  const live = () =>
    store
      .releases(app.id)
      .find((row) => row.branch === options.branch && row.status === "live");
  const release = live();
  if (!release?.container_id)
    throw new Error(`No live release for ${app.name} branch ${options.branch}`);
  if (signal.aborted) return;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  let takeover: number | undefined;
  let pollError: unknown;
  const timer = options.follow
    ? setInterval(() => {
        try {
          const next = live();
          if (next && next.id !== release.id) {
            takeover = next.number;
            controller.abort();
          }
        } catch (error) {
          pollError = error;
          controller.abort();
        }
      }, 2000)
    : undefined;
  try {
    const stream = await docker.containerLogs(
      release.container_id,
      options.follow,
      controller.signal,
      options.lines,
    );
    const reader = stream.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (controller.signal.aborted) cancel();
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        await write(stripCarriageReturns(value));
      }
      // Docker may close the old stream before cutover updates the live row.
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
    if (!controller.signal.aborted) throw error;
  } finally {
    if (timer) clearInterval(timer);
    signal.removeEventListener("abort", abort);
  }
  if (pollError) throw pollError;
  if (takeover !== undefined && !signal.aborted)
    await write(
      new TextEncoder().encode(`--- release v${takeover} took over ---\n`),
    );
}
