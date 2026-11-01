import { SqliteAppLocks } from "../app-lock";
import { FakeStore } from "./store";

// Run the same lease policy over an in-memory store.
export class FakeAppLocks extends SqliteAppLocks {
  constructor() {
    super(new FakeStore());
  }
}
