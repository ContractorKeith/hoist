export interface LockRow {
  name: string;
  owner_pid: number;
  heartbeat_at: string;
  acquired_at: string;
  child_pid: number | null;
}
export type LockClaim =
  | { acquired: true; previous: LockRow | null }
  | { acquired: false; ownerPid: number };
export interface App {
  id: number;
  name: string;
  domain: string;
  health_path: string;
  retention?: number;
  main_branch?: string | null;
  volume_path?: string | null;
  pending_main_branch?: string | null;
}
export interface Release {
  id: number;
  app_id: number;
  branch: string;
  number: number;
  git_sha: string;
  image: string;
  config_json: string;
  container_id?: string | null;
  created_at?: string;
  pruned_at?: string | null;
  status: "building" | "built" | "failed" | "live" | "stopped";
}
export interface Preview {
  app_id: number;
  branch: string;
  slug: string;
  last_push_at: string;
}
export interface Store {
  stopBranchReleases(appId: number, branch: string): void;
  removePreview(appId: number, branch: string): void;
  setVolumePath(appId: number, path: string | null): void;
  setPendingMainBranch(appId: number, branch: string | null): void;
  setMainBranch(appId: number, branch: string): void;
  previews(appId: number): Preview[];
  upsertPreview(input: Preview): void;
  deletePreview(appId: number, branch: string): void;

  secretKey(verifyFile?: boolean): Promise<CryptoKey>;
  config(appId: number): Record<string, string>;
  setConfig(appId: number, key: string, value: string): void;
  unsetConfig(appId: number, key: string): void;
  setRetention(appId: number, retention: number): void;
  markPruned(id: number): void;
  lock(name: string): LockRow | null;
  acquireLock(
    name: string,
    pid: number,
    now: string,
    alive: (pid: number) => boolean,
  ): LockClaim;
  refreshLock(
    name: string,
    pid: number,
    acquiredAt: string,
    now: string,
  ): boolean;
  releaseLock(name: string, pid: number, acquiredAt: string): void;
  setLockChild(
    name: string,
    pid: number,
    acquiredAt: string,
    childPid: number | null,
  ): void;
  latestReleaseNumber(appId: number, branch: string): number;
  transaction<T>(action: () => T): T;
  createApp(name: string, domain: string, healthPath: string): App;
  app(name: string): App | null;
  apps(): App[];
  deleteApp(id: number): void;
  releases(appId: number): Release[];
  insertRelease(input: Omit<Release, "id">): Release;
  completeRelease(id: number): void;
  failRelease(id: number): void;
  setReleaseState(
    id: number,
    status: "live" | "stopped",
    containerId?: string | null,
    expectedStatus?: "built" | "live",
  ): void;
}
