import type { Database } from "bun:sqlite";
import type { LockClaim, LockRow } from "./interface";

export abstract class LockStore {
  abstract readonly db: Database;
  abstract transaction<T>(action: () => T): T;
  lock(name: string): LockRow | null {
    return this.db
      .query<LockRow, [string]>("SELECT * FROM locks WHERE name = ?")
      .get(name);
  }
  acquireLock(
    name: string,
    pid: number,
    now: string,
    alive: (pid: number) => boolean,
  ): LockClaim {
    return this.transaction(() => {
      const previous = this.lock(name);
      if (
        previous &&
        alive(previous.owner_pid) &&
        Date.parse(previous.heartbeat_at) > Date.parse(now) - 60000
      )
        return { acquired: false, ownerPid: previous.owner_pid };
      this.db.run(
        "INSERT INTO locks (name, owner_pid, heartbeat_at, acquired_at, child_pid) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(name) DO UPDATE SET owner_pid=excluded.owner_pid, heartbeat_at=excluded.heartbeat_at, acquired_at=excluded.acquired_at",
        [name, pid, now, now],
      );
      return { acquired: true, previous };
    });
  }
  refreshLock(
    name: string,
    pid: number,
    acquiredAt: string,
    now: string,
  ): boolean {
    return (
      this.db.run(
        "UPDATE locks SET heartbeat_at = ? WHERE name = ? AND owner_pid = ? AND acquired_at = ?",
        [now, name, pid, acquiredAt],
      ).changes === 1
    );
  }
  releaseLock(name: string, pid: number, acquiredAt: string): void {
    this.db.run(
      "DELETE FROM locks WHERE name = ? AND owner_pid = ? AND acquired_at = ?",
      [name, pid, acquiredAt],
    );
  }
  setLockChild(
    name: string,
    pid: number,
    acquiredAt: string,
    childPid: number | null,
  ): void {
    if (
      !this.db.run(
        "UPDATE locks SET child_pid = ? WHERE name = ? AND owner_pid = ? AND acquired_at = ?",
        [childPid, name, pid, acquiredAt],
      ).changes
    )
      throw new Error(`lock ${name} ownership changed`);
  }
}
