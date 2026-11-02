import { expect, test } from "bun:test";
import { FakeStore } from "../../src/adapters/fakes/store";
import { createApp } from "../../src/core/apps";
import { reserveRelease } from "../../src/core/build";
import { availableHost, setMainBranch } from "../../src/core/previews";

test("the dashboard host is reserved for create, reclassification and preview reservation", async () => {
  const old = process.env.HOIST_DASHBOARD_HOST;
  process.env.HOIST_DASHBOARD_HOST = "hoist.example.test";
  const store = new FakeStore();
  let provisioned = false;
  const message = "host hoist.example.test is reserved for the dashboard";
  try {
    expect(() => availableHost(store, "hoist.example.test")).toThrow(message);
    for (const name of ["hoist", "custom"])
      await expect(
        createApp(
          store,
          name,
          "hoist.example.test",
          "/",
          async () => {
            provisioned = true;
          },
          async () => {},
        ),
      ).rejects.toThrow(message);
    expect(provisioned).toBe(false);
    const legacy = store.createApp("legacy", "hoist.example.test", "/");
    expect(() => setMainBranch(store, legacy, "stable")).toThrow(message);
    expect(store.app("legacy")?.main_branch).toBeUndefined();
    const base = store.createApp("base", "example.test", "/");
    expect(() => reserveRelease(store, base, "hoist", "a".repeat(40))).toThrow(
      message,
    );
    expect(store.previews(base.id)).toEqual([]);
    expect(store.releases(base.id)).toEqual([]);
  } finally {
    if (old === undefined) delete process.env.HOIST_DASHBOARD_HOST;
    else process.env.HOIST_DASHBOARD_HOST = old;
  }
});
