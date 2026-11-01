import { open } from "node:fs/promises";
import { join } from "node:path";
import type { DockerClient } from "../adapters/interfaces";
import {
  buildRelease,
  removeReleaseImages,
  reserveRelease,
} from "../core/build";
import { branchSlug } from "../core/validation";
import { privatePath } from "../data";
import type { App, Release, Store } from "../store/interface";
import { checkout, requireDockerfile } from "./repository";

export function parseRefs(input: string): { sha: string; branch: string }[] {
  if (input.length > 1024 * 1024 || input.includes("\0"))
    throw new Error("Invalid ref input");
  const refs: { sha: string; branch: string }[] = [];
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
    refs.push({ sha: match[2] ?? "", branch });
  }
  return refs;
}

export async function receive(
  root: string,
  store: Store,
  docker: DockerClient,
  app: App,
  input: string,
  signal: AbortSignal,
  prepare: typeof checkout = checkout,
): Promise<void> {
  const refs = parseRefs(input);
  if (!refs.length) {
    console.error("hoist: no branch refs in this push; nothing built");
    return;
  }
  const reserved: Release[] = [];
  const repo = join(root, "repos", `${app.name}.git`);
  try {
    for (const { sha, branch } of refs) {
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
            await Bun.write(Bun.stderr, chunk);
          },
          signal,
        );
      } catch (error) {
        store.failRelease(release.id);
        throw error;
      } finally {
        try {
          await file?.close();
        } finally {
          await context?.cleanup();
        }
      }
    }
  } catch (error) {
    for (const release of reserved) {
      store.failRelease(release.id);
      await removeReleaseImages(docker, app, release);
    }
    throw error;
  }
}
