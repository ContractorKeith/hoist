import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";

// All hoist-created files inherit private modes, including git, SQLite and tar children.
export function privatePath(
  path: string,
  directory = true,
  exclusive = false,
): string {
  process.umask(0o077);
  if (directory) mkdirSync(path, { recursive: !exclusive, mode: 0o700 });
  else {
    privatePath(dirname(path));
    closeSync(openSync(path, "a", 0o600));
  }
  chmodSync(path, directory ? 0o700 : 0o600);
  return path;
}

export function dataRoot(): string {
  return privatePath(resolve(process.env.HOIST_DIR ?? "/var/lib/hoist"));
}
