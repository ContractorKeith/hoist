import type { Store } from "../../store/interface";

export class FakeStore implements Store {
  readonly calls: { appId: number; branch: string }[] = [];
  readonly releases: { appId: number; branch: string; number: number }[] = [];

  latestReleaseNumber(appId: number, branch: string): number {
    this.calls.push({ appId, branch });
    return Math.max(
      0,
      ...this.releases
        .filter(
          (release) => release.appId === appId && release.branch === branch,
        )
        .map((release) => release.number),
    );
  }
}
