import type { AppLocks } from "../interfaces";

export class FakeAppLocks implements AppLocks {
  private readonly tails = new Map<string, Promise<void>>();
  isLocked(app: string): boolean {
    return this.tails.has(app);
  }
  async withLock<T>(app: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(app) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(app, next);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(app) === next) this.tails.delete(app);
    }
  }
}
