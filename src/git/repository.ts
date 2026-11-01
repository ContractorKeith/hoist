import {
  chmod,
  lstat,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { privatePath } from "../data";

export async function git(args: string[], cwd?: string): Promise<string> {
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
  const repo = join(privatePath(join(root, "repos")), `${name}.git`);
  privatePath(repo, true, true);
  try {
    await git(["init", "--bare", "--initial-branch=main", repo]);
    await writeFile(
      join(repo, "hooks/pre-receive"),
      `#!/bin/sh\nexec ${executableCommand()} git-hook pre-receive ${shellQuote(name)}\n`,
      { mode: 0o700 },
    );
    await chmod(join(repo, "hooks/pre-receive"), 0o700);
  } catch (error) {
    await rm(repo, { recursive: true, force: true });
    throw error;
  }
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
  const path = await mkdtemp(join(privatePath(join(root, "tmp")), "checkout-"));
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
