import { appName } from "../core/validation";
import type { Store } from "../store/interface";
import type { AppLocks } from "./interfaces";

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export class SqliteAppLocks implements AppLocks {
  constructor(
    private readonly store: Store,
    private readonly pid = process.pid,
  ) {}
  isLocked(app: string): boolean {
    const row = this.store.lock(`app:${appName(app)}`);
    return (
      !!row &&
      processAlive(row.owner_pid) &&
      Date.parse(row.heartbeat_at) > Date.now() - 60000
    );
  }
  async acquire(
    name: string,
    options: { signal?: AbortSignal; failFast?: boolean } = {},
  ) {
    const deadline = Date.now() + 600000;
    while (true) {
      options.signal?.throwIfAborted();
      const acquiredAt = new Date().toISOString();
      const claim = this.store.acquireLock(
        name,
        this.pid,
        acquiredAt,
        processAlive,
      );
      if (claim.acquired) {
        const heartbeat = setInterval(() => {
          if (
            !this.store.refreshLock(
              name,
              this.pid,
              acquiredAt,
              new Date().toISOString(),
            )
          )
            clearInterval(heartbeat);
        }, 10000);
        heartbeat.unref();
        let released = false;
        return {
          previousChildPid: claim.previous?.child_pid ?? null,
          setChild: (pid: number | null) =>
            this.store.setLockChild(name, this.pid, acquiredAt, pid),
          release: () => {
            if (released) return;
            released = true;
            clearInterval(heartbeat);
            // Failed startup must retain an unreaped child's PID for the next owner.
            if (name === "serve" && this.store.lock(name)?.child_pid) return;
            this.store.releaseLock(name, this.pid, acquiredAt);
          },
        };
      }
      if (options.failFast && name === "serve")
        throw new Error(
          `hoist serve is already running (pid ${claim.ownerPid})`,
        );
      if (options.failFast || Date.now() >= deadline)
        throw new Error(
          `another push to ${name.replace(/^app:/, "")} is in progress`,
        );
      await wait(200, options.signal);
    }
  }
  async withLock<T>(
    app: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const lease = await this.acquire(`app:${appName(app)}`, { signal });
    try {
      signal?.throwIfAborted();
      return await action();
    } finally {
      lease.release();
    }
  }
}
