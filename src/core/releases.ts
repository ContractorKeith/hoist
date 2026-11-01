import type { Store } from "../store/interface";

// This is a read, not a reservation. Reserve and insert inside one store transaction.
export function nextReleaseNumber(
  store: Store,
  appId: number,
  branch: string,
): number {
  return store.latestReleaseNumber(appId, branch) + 1;
}
