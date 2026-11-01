import { expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { parseCli } from "../../src/cli/index";
import { buildRelease, reserveRelease } from "../../src/core/build";
import { appName, branchSlug, healthPath } from "../../src/core/validation";
import { parseDispatch } from "../../src/git/dispatch";
import { parseRefs, receive } from "../../src/git/hook";
import { checkout, git } from "../../src/git/repository";
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

test("release numbering and slug collision checks are branch-scoped on SQLite", async () => {
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

test("fake build consumes logs, leaves success built, marks errors failed and removes its partial image", async () => {
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
  expect(row.status).toBe("built");
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

test("checkout rejects HOIST_DIR/tmp symlinked outside the data root", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoist-confine-"));
  const outside = await mkdtemp(join(tmpdir(), "hoist-outside-"));
  try {
    const repo = join(root, "source");
    await mkdir(repo);
    await git(["init", "--initial-branch=main", repo]);
    await writeFile(join(repo, "Dockerfile"), "FROM scratch\n");
    await git(["add", "."], repo);
    await git(
      [
        "-c",
        "user.name=ContractorKeith",
        "-c",
        "user.email=ContractorKeith@users.noreply.github.com",
        "commit",
        "-m",
        "fixture",
      ],
      repo,
    );
    const commit = await git(["rev-parse", "HEAD"], repo);
    await symlink(outside, join(root, "tmp"));
    await expect(
      checkout(root, join(repo, ".git"), commit, new AbortController().signal),
    ).rejects.toThrow("escapes");
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
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

test("reservation holds the transaction lock against an interleaved writer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hoist-reservation-"));
  const a = new SqliteStore(dir),
    b = new SqliteStore(dir);
  try {
    b.db.exec("PRAGMA busy_timeout = 0");
    const app = a.createApp("hello", "hello.test", "/");
    const latest = a.latestReleaseNumber.bind(a);
    let blocked = false;
    a.latestReleaseNumber = (appId, branch) => {
      const number = latest(appId, branch);
      try {
        b.insertRelease({
          app_id: appId,
          branch,
          number: number + 1,
          git_sha: sha,
          image: "hoist/hello:competing",
          config_json: "{}",
          status: "building",
        });
      } catch (error) {
        expect(String(error)).toContain("locked");
        blocked = true;
      }
      return number;
    };
    const reserved = reserveRelease(a, app, "main", sha);
    expect(blocked).toBe(true);
    expect(reserved.number).toBe(1);
    expect(b.releases(app.id)).toHaveLength(1);
  } finally {
    a.close();
    b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("repeated SHAs keep distinct immutable image tags across releases and branches", () => {
  const store = new FakeStore();
  const app = store.createApp("hello", "hello.test", "/");
  const one = reserveRelease(store, app, "main", sha);
  const two = reserveRelease(store, app, "main", sha);
  const other = reserveRelease(store, app, "feature/x", sha);
  expect(one.image).toBe(`hoist/hello:main-v1-${sha.slice(0, 12)}`);
  expect(two.image).toBe(`hoist/hello:main-v2-${sha.slice(0, 12)}`);
  expect(other.image).toBe(`hoist/hello:feature-x-v1-${sha.slice(0, 12)}`);
  expect(new Set([one.image, two.image, other.image]).size).toBe(3);
});

test("receive fails and cleans every reserved release when the second ref cannot prepare", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoist-push-"));
  const store = new FakeStore(),
    docker = new FakeDocker();
  const app = store.createApp("hello", "hello.test", "/");
  const error = new Error("second checkout failed");
  let prepared = 0;
  try {
    await writeFile(join(root, "Dockerfile"), "FROM scratch\n");
    await expect(
      receive(
        root,
        store,
        docker,
        app,
        `${zero} ${sha} refs/heads/main\n${zero} ${sha} refs/heads/feature-x\n`,
        new AbortController().signal,
        async () => {
          if (++prepared === 2) throw error;
          return { path: root, cleanup: async () => {} };
        },
      ),
    ).rejects.toBe(error);
    expect(store.rows.map((row) => row.status)).toEqual(["failed", "failed"]);
    expect(docker.images.size).toBe(0);
    expect(
      docker.calls.filter((call) => call.method === "buildImage"),
    ).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup continues after removeImage fails and preserves the original build error", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker();
  const app = store.createApp("hello", "hello.test", "/");
  const row = reserveRelease(store, app, "main", sha);
  const original = new Error("original build failure");
  docker.buildImage = async (input) => {
    docker.images.set("hoist/hello:partial-one", input.labels);
    docker.images.set("hoist/hello:partial-two", input.labels);
    return new ReadableStream({
      start(controller) {
        controller.error(original);
      },
    });
  };
  const remove = docker.removeImage.bind(docker);
  const attempted: string[] = [];
  docker.removeImage = async (image) => {
    attempted.push(image);
    if (attempted.length === 1) throw new Error("cleanup failed");
    await remove(image);
  };
  await expect(
    buildRelease(
      store,
      docker,
      row,
      app,
      async () => "/checkout",
      async () => {},
      new AbortController().signal,
    ),
  ).rejects.toBe(original);
  expect(attempted).toEqual([
    "hoist/hello:partial-one",
    "hoist/hello:partial-two",
  ]);
  expect(docker.images.has("hoist/hello:partial-two")).toBe(false);
  expect(row.status).toBe("failed");
});

test("mid-stream abort fails the release, logs the error and removes its partial image", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker();
  const app = store.createApp("hello", "hello.test", "/");
  const row = reserveRelease(store, app, "main", sha);
  const abort = new AbortController(),
    original = new Error("pusher disconnected mid-stream");
  docker.buildImage = async (input, signal) => {
    docker.images.set(input.tag, input.labels);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("progress\n"));
        signal.addEventListener(
          "abort",
          () => controller.error(signal.reason),
          { once: true },
        );
      },
    });
  };
  let log = "";
  await expect(
    buildRelease(
      store,
      docker,
      row,
      app,
      async () => "/checkout",
      async (chunk) => {
        const text = new TextDecoder().decode(chunk);
        log += text;
        if (text === "progress\n") abort.abort(original);
      },
      abort.signal,
    ),
  ).rejects.toBe(original);
  expect(row.status).toBe("failed");
  expect(log).toBe("progress\npusher disconnected mid-stream\n");
  expect(docker.images.has(row.image)).toBe(false);
});

test("tag-only and delete-only pushes explain that nothing was built", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker();
  const app = store.createApp("hello", "hello.test", "/");
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const input of [
      `${zero} ${sha} refs/tags/v1\n`,
      `${sha} ${zero} refs/heads/main\n`,
    ]) {
      await receive(
        "/unused",
        store,
        docker,
        app,
        input,
        new AbortController().signal,
      );
    }
    expect(stderr.mock.calls).toEqual([
      ["hoist: no branch refs in this push; nothing built"],
      ["hoist: no branch refs in this push; nothing built"],
    ]);
    expect(store.rows).toEqual([]);
    expect(docker.calls).toEqual([]);
  } finally {
    stderr.mockRestore();
  }
});
