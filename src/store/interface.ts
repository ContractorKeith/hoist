export interface App {
  id: number;
  name: string;
  domain: string;
  health_path: string;
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
  status: "building" | "built" | "failed" | "live" | "stopped";
}
export interface Store {
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
