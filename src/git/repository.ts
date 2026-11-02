import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { processAlive } from "../adapters/app-lock";
import { appName, branchSlug } from "../core/validation";
import { privatePath } from "../data";

export async function git(
  args: string[],
  cwd?: string,
  missingOkay = false,
): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code === 1 && missingOkay) return "";
  if (code) throw new Error(`git failed: ${errors.trim()}`);
  return output.trim();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
export function executableCommand(): string {
  return process.execPath.endsWith("/bun")
    ? `${shellQuote(process.execPath)} ${shellQuote(Bun.main)}`
    : shellQuote(process.execPath);
}
export async function createRepo(root: string, name: string): Promise<void> {
  const repo = join(
    privatePath(join(root, "repos"), true, false, root),
    `${name}.git`,
  );
  privatePath(repo, true, true, root);
  try {
    await git(["init", "--bare", "--initial-branch=main", repo]);
    await rewriteHooks(root, name);
  } catch (error) {
    await rm(repo, { recursive: true, force: true });
    throw error;
  }
}

const activeStaging = new Set<string>();

// Keep creation and upgrade repair on exactly the same hook template.
export async function rewriteHooks(
  root: string,
  name: string,
): Promise<string[]> {
  appName(name);
  const changes: string[] = [];
  for (const hook of ["pre-receive", "post-receive"]) {
    const directory = privatePath(
      join(root, "repos", `${name}.git`, "hooks"),
      true,
      false,
      root,
    );
    // Remove abandoned files, but never unlink another running repair's staging file.
    for (const staged of await readdir(directory)) {
      if (!staged.startsWith(`.${hook}.`) || !staged.endsWith(".next"))
        continue;
      const candidate = join(directory, staged);
      const pid = Number(staged.slice(hook.length + 2).split(".")[0]);
      if (
        activeStaging.has(candidate) ||
        (pid > 0 &&
          pid <= 2147483647 &&
          Number.isInteger(pid) &&
          pid !== process.pid &&
          processAlive(pid))
      )
        continue;
      await rm(candidate, { force: true });
    }
    const path = join(directory, hook);
    const entry = await lstat(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (entry && !entry.isFile())
      throw new Error(`${path} must be a regular file`);
    const expected = `#!/bin/sh\nexec ${executableCommand()} git-hook ${hook} ${shellQuote(name)}\n`;
    const previous = entry ? await readFile(path, "utf8") : "";
    if (previous !== expected) {
      const next = join(
        directory,
        `.${hook}.${process.pid}.${randomUUID()}.next`,
      );
      activeStaging.add(next);
      try {
        const file = await open(next, "wx", 0o700);
        try {
          await file.writeFile(expected);
        } finally {
          // Close the writable descriptor before publishing so Git can exec immediately.
          await file.close();
        }
        await rename(next, path);
      } catch (error) {
        await rm(next, { force: true });
        throw error;
      } finally {
        activeStaging.delete(next);
      }
      changes.push(
        `${name} ${hook}: replaced ${previous.trim().replace(/\s+/g, " ")} with ${expected.trim().replace(/\s+/g, " ")}`,
      );
    }
    await chmod(path, 0o700);
  }
  return changes;
}
export async function repairRepoHooks(root: string): Promise<string[]> {
  const repos = privatePath(join(root, "repos"), true, false, root);
  const changes: string[] = [];
  for (const entry of await readdir(repos)) {
    try {
      if (!entry.endsWith(".git")) throw new Error("not a bare repository");
      appName(entry.slice(0, -4));
      const repo = join(repos, entry);
      const [head, objects] = await Promise.all([
        lstat(join(repo, "HEAD")).catch(() => null),
        lstat(join(repo, "objects")).catch(() => null),
      ]);
      if (!head?.isFile() || !objects?.isDirectory())
        throw new Error("not a bare repository");
    } catch (error) {
      changes.push(
        `skipped ${entry}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    changes.push(...(await rewriteHooks(root, entry.slice(0, -4))));
  }
  return changes;
}

export async function confinedContext(
  root: string,
  context: string,
): Promise<string> {
  const [base, target] = await Promise.all([realpath(root), realpath(context)]);
  const path = relative(base, target);
  if (!path || path === ".." || path.startsWith("../") || isAbsolute(path))
    throw new Error("Build context escapes HOIST_DIR");
  return target;
}

export async function checkout(
  root: string,
  repo: string,
  sha: string,
  signal: AbortSignal,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(
    join(privatePath(join(root, "tmp"), true, false, root), "checkout-"),
  );
  try {
    const archive = Bun.spawn(
      ["git", "--git-dir", repo, "archive", "--format=tar", sha],
      { stdout: "pipe", stderr: "pipe", signal },
    );
    const extract = Bun.spawn(["tar", "-x", "--no-same-owner", "-C", path], {
      stdin: archive.stdout,
      signal,
      stdout: "ignore",
      stderr: "pipe",
    });
    const [a, b, ae, be] = await Promise.all([
      archive.exited,
      extract.exited,
      new Response(archive.stderr).text(),
      new Response(extract.stderr).text(),
    ]);
    if (a || b) throw new Error(`Checkout failed: ${ae} ${be}`);
    return {
      path: await confinedContext(root, path),
      cleanup: () => rm(path, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}

export async function requireDockerfile(path: string): Promise<void> {
  const entry = await lstat(join(path, "Dockerfile")).catch(() => null);
  if (!entry?.isFile())
    throw new Error(
      "Missing root Dockerfile; add a Dockerfile at the repository root and push again",
    );
}

export const gitRefs = {
  objectType: (repo: string, sha: string) =>
    git(["--git-dir", repo, "cat-file", "-t", sha]),
  head: async (repo: string, branch: string): Promise<string | null> =>
    (await git(
      [
        "--git-dir",
        repo,
        "rev-parse",
        "--verify",
        "-q",
        `refs/heads/${branch}`,
      ],
      undefined,
      true,
    )) || null,
};

export async function deleteBranch(
  root: string,
  app: string,
  branch: string,
): Promise<void> {
  appName(app);
  branchSlug(branch);
  await git([
    "--git-dir",
    join(root, "repos", `${app}.git`),
    "update-ref",
    "-d",
    `refs/heads/${branch}`,
  ]);
}
