import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

function entry(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Only the data root itself may be a symlink; inspect descendants before touching modes.
export function privatePath(
  path: string,
  directory = true,
  exclusive = false,
  root = parse(resolve(path)).root,
): string {
  process.umask(0o077);
  const base = resolve(root),
    target = resolve(path),
    parts = relative(base, target).split("/").filter(Boolean);
  if (parts.includes("..")) throw new Error("Private path escapes HOIST_DIR");
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    if (entry(current)?.isSymbolicLink())
      throw new Error(
        `${current} is a symlink; hoist does not follow symlinks inside HOIST_DIR`,
      );
  }
  if (directory) mkdirSync(target, { recursive: !exclusive, mode: 0o700 });
  else {
    privatePath(dirname(target), true, false, base);
    if (!entry(target)) closeSync(openSync(target, "ax", 0o600));
  }
  const mode = directory ? 0o700 : 0o600;
  if ((statSync(target).mode & 0o7777 & ~mode) !== 0) chmodSync(target, mode);
  return target;
}

export function dataRoot(): string {
  const root = process.env.HOIST_DIR ?? "/var/lib/hoist";
  if (!isAbsolute(root)) throw new Error("HOIST_DIR must be an absolute path");
  return privatePath(root, true, false, root);
}
