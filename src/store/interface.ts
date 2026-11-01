export interface Store {
  latestReleaseNumber(appId: number, branch: string): number;
}
