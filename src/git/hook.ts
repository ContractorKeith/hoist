import { open } from "node:fs/promises";
import { join } from "node:path";
import { FileAppLocks } from "../adapters/app-lock";
import type { CaddyAdmin, DockerClient } from "../adapters/interfaces";
import {
  buildRelease,
  removeReleaseImages,
  reserveRelease,
} from "../core/build";
import { cutover, type HealthCheck } from "../core/cutover";
import { branchSlug } from "../core/validation";
import { privatePath } from "../data";
import type { App, Release, Store } from "../store/interface";
import { checkout, gitRefs, requireDockerfile } from "./repository";

export function parseRefs(
  input: string,
): { oldSha: string; sha: string; branch: string }[] {
  if (input.length > 1024 * 1024 || input.includes("\0"))
    throw new Error("Invalid ref input");
  const refs: { oldSha: string; sha: string; branch: string }[] = [];
  const slugs = new Set<string>();
  for (const line of input.split("\n")) {
    if (!line) continue;
    const match = /^([a-f0-9]{40}) ([a-f0-9]{40}) (refs\/[^ ]{1,220})$/.exec(
      line,
    );
    if (
      !match ||
      [...line].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw new Error("Invalid pre-receive ref line");
    if (
      !(match[3] ?? "").startsWith("refs/heads/") ||
      /^0+$/.test(match[2] ?? "")
    )
      continue;
    const branch = (match[3] ?? "").slice(11);
    const slug = branchSlug(branch);
    if (slugs.has(slug)) throw new Error("Branch slug collision in push");
    slugs.add(slug);
    refs.push({ oldSha: match[1] ?? "", sha: match[2] ?? "", branch });
  }
  return refs;
}

export async function receive(
  ...args: Parameters<typeof receiveLocked>
): Promise<void> {
  if (!parseRefs(args[4]).length) return receiveLocked(...args);
  const [root, , , app] = args;
  await new FileAppLocks(root).withLock(app.name, () => receiveLocked(...args));
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
  const refs = parseRefs(input);
  if (!refs.length) {
    console.error("hoist: no branch refs in this push; nothing built");
    return;
  }
  const reserved: Release[] = [];
  const repo = join(root, "repos", `${app.name}.git`);
  try {
    for (const { oldSha, sha, branch } of refs) {
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
          async (chunk) => {
            await logFile.writeFile(chunk);
            await Bun.write(Bun.stderr, chunk).catch(() => {});
          },
          signal,
          async () => {
            const current = await refsClient.head(repo, branch);
            if ((current ?? "0".repeat(40)) !== oldSha)
              throw new Error(
                `branch ${branch} moved during build; push again`,
              );
          },
        );
      } finally {
        try {
          await file?.close();
        } finally {
          await context?.cleanup();
        }
      }
    }
    // Finish every build before any cutover, so a bad second ref cannot leave the first live.
    for (const release of reserved) {
      // TODO M5: non-main branches gain preview hosts and their own cutover.
      if (release.branch !== "main") continue;
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
            await logFile.writeFile(chunk);
            await Bun.write(Bun.stderr, chunk).catch(() => {});
          },
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
