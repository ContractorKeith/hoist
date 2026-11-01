import type { Store } from "../store/interface";

// This is a read, not a reservation. M1 must insert under a store transaction.
export function nextReleaseNumber(
  store: Store,
  appId: number,
  branch: string,
): number {
  return store.latestReleaseNumber(appId, branch) + 1;
}
