import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { appName } from "../core/validation";
import { privatePath } from "../data";
import type { AppLocks } from "./interfaces";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export class FileAppLocks implements AppLocks {
  constructor(private readonly root: string) {}
  private path(app: string): string {
    return join(
      privatePath(join(this.root, "locks"), true, false, this.root),
      `${appName(app)}.lock`,
    );
  }
  isLocked(app: string): boolean {
    try {
      const pid = Number(readFileSync(this.path(app), "utf8"));
      return !Number.isInteger(pid) || pid <= 0 || alive(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async withLock<T>(app: string, action: () => Promise<T>): Promise<T> {
    const path = this.path(app),
      deadline = Date.now() + 600000;
    let owned: ReturnType<typeof statSync> | undefined;
    while (!owned) {
      try {
        const fd = openSync(path, "wx", 0o600);
        try {
          writeFileSync(fd, String(process.pid));
          owned = statSync(path);
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const before = statSync(path),
            pid = Number(readFileSync(path, "utf8"));
          if (
            Number.isInteger(pid) &&
            pid > 0 &&
            !alive(pid) &&
            statSync(path).ino === before.ino
          ) {
            unlinkSync(path);
            continue;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (Date.now() >= deadline)
          throw new Error(`another push to ${app} is in progress`);
        await Bun.sleep(200);
      }
    }
    try {
      return await action();
    } finally {
      try {
        if (statSync(path).ino === owned.ino) unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          console.error(`Cannot release app lock ${path}: ${String(error)}`);
      }
    }
  }
}
