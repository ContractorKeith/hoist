import { open } from "node:fs/promises";
import { join } from "node:path";
import { SqliteAppLocks } from "../adapters/app-lock";
import type { CaddyAdmin, DockerClient } from "../adapters/interfaces";
import {
  buildRelease,
  removeReleaseImages,
  reserveRelease,
} from "../core/build";
import { buildLogDecoder, releaseLogSink } from "../core/build-logs";
import { cutover, type HealthCheck } from "../core/cutover";
import { removeReleaseLogs } from "../core/logs";
import { releaseHost } from "../core/previews";
import { prune } from "../core/retention";
import { branchSlug } from "../core/validation";
import { privatePath } from "../data";
import type { App, Release, Store } from "../store/interface";
import { checkout, gitRefs, requireDockerfile } from "./repository";

export { parseRefs } from "./refs";

import { parseRefs } from "./refs";

export async function receive(
  ...args: Parameters<typeof receiveLocked>
): Promise<void> {
  if (!parseRefs(args[4]).length) return receiveLocked(...args);
  const [, store, , app, , signal] = args;
  await new SqliteAppLocks(store).withLock(
    app.name,
    () => receiveLocked(...args),
    signal,
  );
}

async function receiveLocked(
  root: string,
  store: Store,
  docker: DockerClient,
  app: App,
  input: string,
  signal: AbortSignal,
  edge: { caddy: CaddyAdmin; health: HealthCheck },
  prepare: typeof checkout = checkout,
  refsClient: typeof gitRefs = gitRefs,
): Promise<void> {
  app = store.app(app.name) ?? app;
  const refs = parseRefs(input);
  const updates = refs.filter((ref) => !/^0+$/.test(ref.sha));
  if (updates.length > 1)
    throw new Error(
      `hoist deploys one branch per push; push ${updates.map((ref) => ref.branch).join(" and ")} separately`,
    );
  if (
    refs.some(
      (ref) =>
        /^0+$/.test(ref.sha) && ref.branch === (app.main_branch ?? "main"),
    )
  )
    throw new Error("The main branch cannot be deleted.");
  if (!refs.length) {
    console.error("hoist: no branch refs in this push; nothing built");
    return;
  }
  const reserved: Release[] = [];
  const repo = join(root, "repos", `${app.name}.git`);
  try {
    for (const { oldSha, sha, branch } of refs) {
      if (/^0+$/.test(sha)) continue;
      if ((await refsClient.objectType(repo, sha)) !== "commit")
        throw new Error("pushed object is not a commit");
      const release = reserveRelease(store, app, branch, sha);
      reserved.push(release);
      let context: Awaited<ReturnType<typeof checkout>> | undefined;
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        const path = privatePath(
          join(
            root,
            "releases",
            app.name,
            branchSlug(branch),
            `v${release.number}`,
            "build.log",
          ),
          false,
          false,
          root,
        );
        const logFile = await open(path, "a", 0o600);
        file = logFile;
        const decoded = buildLogDecoder(
          releaseLogSink(
            (chunk) => logFile.writeFile(chunk),
            (chunk) => Bun.write(Bun.stderr, chunk),
          ),
        );
        try {
          await buildRelease(
            store,
            docker,
            release,
            app,
            async () => {
              context = await prepare(root, repo, sha, signal);
              await requireDockerfile(context.path);
              return context.path;
            },
            decoded.write,
            signal,
            async () => {
              const current = await refsClient.head(repo, branch);
              if ((current ?? "0".repeat(40)) !== oldSha)
                throw new Error(
                  `branch ${branch} moved during build; push again`,
                );
            },
            async (message) => {
              await decoded.flush();
              await decoded.write(
                new TextEncoder().encode(
                  `${JSON.stringify({ error: message.replace(/[\r\n]+/g, " ") })}\n`,
                ),
              );
            },
          );
        } finally {
          await decoded.flush();
        }
      } finally {
        try {
          await file?.close();
        } finally {
          await context?.cleanup();
        }
      }
    }
    // Finish the branch build before entering the cutover phase.
    for (const release of reserved) {
      const built = store.releases(app.id).find((row) => row.id === release.id);
      const ref = refs.find((row) => row.branch === release.branch);
      if (!built || !ref) throw new Error("Release disappeared before cutover");
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
      const logFile = await open(path, "a", 0o600);
      const log = releaseLogSink(
        (chunk) => logFile.writeFile(chunk),
        (chunk) => Bun.write(Bun.stderr, chunk),
      );
      try {
        await cutover(
          store,
          docker,
          edge.caddy,
          app,
          built,
          /^0+$/.test(ref.oldSha) ? null : ref.oldSha,
          () => refsClient.head(repo, release.branch),
          edge.health,
          async (message) => {
            const chunk = new TextEncoder().encode(`${message}\n`);
            await log(chunk);
          },
          releaseHost(app, release.branch),
        );
        await prune(
          store,
          docker,
          app,
          (row) =>
            removeReleaseLogs(root, app.name, row.branch, row.number, store),
          async (message) => {
            await logFile.writeFile(`${message}\n`);
          },
          release.branch,
        );
      } finally {
        await logFile.close();
      }
    }
  } catch (error) {
    for (const release of reserved) {
      if (
        store.releases(app.id).find((row) => row.id === release.id)?.status ===
        "live"
      )
        continue;
      try {
        store.failRelease(release.id);
      } catch {
        /* Still remove images if the row vanished. */
      }
      await removeReleaseImages(docker, app, release);
    }
    throw error;
  }
}
