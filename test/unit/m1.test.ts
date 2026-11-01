import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { parseCli } from "../../src/cli/index";
import { buildRelease, reserveRelease } from "../../src/core/build";
import { appName, branchSlug, healthPath } from "../../src/core/validation";
import { parseDispatch } from "../../src/git/dispatch";
import { parseRefs } from "../../src/git/hook";
import { confinedContext } from "../../src/git/repository";
import { SqliteStore } from "../../src/store/sqlite";

const sha = "a".repeat(40),
  zero = "0".repeat(40);
test("app, branch and health validation rejects unsafe or unbounded names", () => {
  for (const name of ["a", "hello-world", `a${"b".repeat(39)}`])
    expect(appName(name)).toBe(name);
  for (const name of [
    "",
    "-hello",
    "hello-",
    "Hello",
    "a/b",
    "..",
    "a\0",
    "a".repeat(41),
  ])
    expect(() => appName(name)).toThrow();
  expect(branchSlug("feature/Hello_world")).toBe("feature-hello-world");
  for (const branch of [
    "",
    "___",
    "a..b",
    "a.lock",
    "a//b",
    "a/../b",
    "a\0",
    "a b",
    "a@{b",
    "a".repeat(201),
  ])
    expect(() => branchSlug(branch)).toThrow();
  expect(healthPath("/health/ready")).toBe("/health/ready");
  for (const path of [
    "//evil?x",
    "/../x",
    "relative",
    "/\n",
    `/${"a".repeat(2048)}`,
  ])
    expect(() => healthPath(path)).toThrow();
});

test("SSH dispatch accepts only one app component and never shell syntax", () => {
  for (const remote of ["hello", "hello.git", "/hello.git"]) {
    for (const value of [remote, `'${remote}'`, `"${remote}"`])
      expect(parseDispatch(`git-receive-pack ${value}`)).toEqual({
        kind: "receive",
        app: "hello",
      });
  }
  for (const command of [
    "git-upload-pack 'hello.git'",
    "git-receive-pack '../hello.git'",
    "git-receive-pack '/etc/hello.git'",
    "git-receive-pack '//hello.git'",
    "git-receive-pack",
    "git-receive-pack hello extra",
    "git-receive-pack 'hello",
    "git-receive-pack 'hello\0'",
    "git-receive-pack hello;id",
    "$(id)",
    "x".repeat(8193),
    "",
  ])
    expect(() => parseDispatch(command)).toThrow();
  expect(
    parseDispatch("hoist apps:create 'hello' --domain hello.test"),
  ).toEqual({
    kind: "cli",
    args: ["apps:create", "hello", "--domain", "hello.test"],
  });
  expect(parseDispatch("apps:list --json")).toEqual({
    kind: "cli",
    args: ["apps:list", "--json"],
  });
  for (const args of [
    ["apps:create", "hello", "--force"],
    ["apps:list", "extra"],
    ["apps:destroy", "hello", "--json"],
    ["serve"],
    ["ssh-dispatch"],
    ["git-hook", "pre-receive", "hello"],
    ["apps:create", "hello", "--domain", "bad"],
  ])
    expect(() => parseCli(args)).toThrow();
});

test("hook refs validate SHAs, ignore tags and deletes, and reject slug collisions", () => {
  expect(
    parseRefs(
      `${zero} ${sha} refs/heads/main\n${sha} ${zero} refs/heads/old\n${zero} ${sha} refs/tags/v1\n`,
    ),
  ).toEqual([{ sha, branch: "main" }]);
  for (const value of [
    "bad\n",
    `${zero} nope refs/heads/main`,
    `${zero} ${sha} refs/heads/../bad`,
    `${zero} ${sha} refs/heads/feature/x\n${zero} ${sha} refs/heads/feature-x`,
    "a".repeat(1048577),
  ])
    expect(() => parseRefs(value)).toThrow();
});

test("release reservations are atomic and branch-scoped on SQLite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoist-number-"));
  const a = new SqliteStore(dir),
    b = new SqliteStore(dir);
  try {
    const app = a.createApp("hello", "hello.test", "/");
    expect(reserveRelease(a, app, "main", sha).number).toBe(1);
    expect(reserveRelease(b, app, "main", sha).number).toBe(2);
    expect(reserveRelease(b, app, "feature/x", sha).number).toBe(1);
    expect(() => reserveRelease(a, app, "feature-x", sha)).toThrow("collides");
    expect(() =>
      a.transaction(() => {
        reserveRelease(a, app, "main", sha);
        throw new Error("rollback");
      }),
    ).toThrow();
    expect(reserveRelease(b, app, "main", sha).number).toBe(3);
  } finally {
    a.close();
    b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("fake build consumes logs, leaves success building, marks errors failed and removes its partial image", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker();
  const app = store.createApp("hello", "hello.test", "/");
  const row = reserveRelease(store, app, "main", sha);
  let log = "";
  const write = async (chunk: Uint8Array) => {
    log += new TextDecoder().decode(chunk);
  };
  await buildRelease(
    store,
    docker,
    row,
    app,
    async () => "/checkout",
    write,
    new AbortController().signal,
  );
  expect(row.status).toBe("building");
  expect(log).toBe("built\n");
  const failed = reserveRelease(store, app, "main", "b".repeat(40));
  docker.buildImage = async (input) => {
    docker.images.set(input.tag, input.labels);
    return new ReadableStream({
      start(controller) {
        controller.error(new Error("build failed"));
      },
    });
  };
  await expect(
    buildRelease(
      store,
      docker,
      failed,
      app,
      async () => "/checkout",
      write,
      new AbortController().signal,
    ),
  ).rejects.toThrow("build failed");
  expect(failed.status).toBe("failed");
  expect(log).toContain("build failed");
  expect(docker.images.has(failed.image)).toBe(false);
  expect(docker.images.has(row.image)).toBe(true);
  const missing = reserveRelease(store, app, "main", sha);
  await expect(
    buildRelease(
      store,
      docker,
      missing,
      app,
      async () => {
        throw new Error("Missing root Dockerfile");
      },
      write,
      new AbortController().signal,
    ),
  ).rejects.toThrow("Dockerfile");
  expect(missing.status).toBe("failed");
});

test("realpath confinement rejects a checkout symlink outside HOIST_DIR", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoist-confine-"));
  try {
    await symlink(tmpdir(), join(root, "escape"));
    await expect(confinedContext(root, join(root, "escape"))).rejects.toThrow(
      "escapes",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("app lifecycle uses fake seams and refuses duplicate creation", async () => {
  const { createApp, destroyApp } = await import("../../src/core/apps");
  const store = new FakeStore(),
    docker = new FakeDocker();
  let provisioned = 0,
    cleaned = 0;
  const app = await createApp(
    store,
    "hello",
    "hello.test",
    "/ready",
    async () => {
      provisioned++;
    },
    async () => {
      cleaned++;
    },
  );
  await expect(
    createApp(
      store,
      "hello",
      "hello.test",
      "/",
      async () => {
        provisioned++;
      },
      async () => {
        cleaned++;
      },
    ),
  ).rejects.toThrow("already exists");
  expect(provisioned).toBe(1);
  docker.images.set("hoist/hello:old", { "hoist.app": "hello" });
  docker.images.set("hoist/other:old", { "hoist.app": "other" });
  expect(reserveRelease(store, app, "main", sha).number).toBe(1);
  expect(reserveRelease(store, app, "main", sha).number).toBe(2);
  await destroyApp(store, docker, app, async () => {
    cleaned++;
  });
  expect(cleaned).toBe(1);
  expect(store.apps()).toEqual([]);
  expect(store.releases(app.id)).toEqual([]);
  expect([...docker.images.keys()]).toEqual(["hoist/other:old"]);
});
