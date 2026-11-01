import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Docker } from "../../src/adapters/docker";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { FakeStore } from "../../src/adapters/fakes/store";
import { parseCli } from "../../src/cli/index";
import { createApp, destroyApp } from "../../src/core/apps";
import { buildRelease, reserveRelease } from "../../src/core/build";
import { dataRoot, privatePath } from "../../src/data";
import { receive } from "../../src/git/hook";
import { requireDockerfile } from "../../src/git/repository";

const sha = "a".repeat(40),
  zero = "0".repeat(40);

test("destroy refuses an in-flight build without touching images, files or rows", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker();
  const app = store.createApp("hello", "hello.test", "/");
  const row = reserveRelease(store, app, "main", sha);
  let cleaned = false;
  await expect(
    destroyApp(store, docker, app, async () => {
      cleaned = true;
    }),
  ).rejects.toThrow(
    "a build is in progress for hello; wait for it to finish and retry",
  );
  expect(cleaned).toBe(false);
  expect(docker.calls).toEqual([]);
  expect(store.app("hello")).toEqual(app);
  expect(row.status).toBe("building");
  store.completeRelease(row.id);
  await destroyApp(store, docker, app, async () => {
    cleaned = true;
  });
  expect(cleaned).toBe(true);
  expect(store.apps()).toEqual([]);
});

test("missing fake release transitions throw and a vanished row still cleans the completed image", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker();
  const app = store.createApp("hello", "hello.test", "/");
  const row = reserveRelease(store, app, "main", sha);
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
        if (text === "built\n") store.deleteApp(app.id);
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow(`release ${row.id} no longer exists`);
  expect(log).toContain(`release ${row.id} no longer exists`);
  expect(docker.images.size).toBe(0);
  expect(() => store.completeRelease(row.id)).toThrow(
    `release ${row.id} no longer exists`,
  );
  expect(() => store.failRelease(row.id)).toThrow(
    `release ${row.id} no longer exists`,
  );
});

test("dataRoot refuses relative HOIST_DIR before creating paths", () => {
  const original = process.env.HOIST_DIR;
  try {
    process.env.HOIST_DIR = "relative";
    expect(() => dataRoot()).toThrow("HOIST_DIR must be an absolute path");
  } finally {
    if (original === undefined) delete process.env.HOIST_DIR;
    else process.env.HOIST_DIR = original;
  }
});

test("privatePath rejects symlinked descendants without chmod and preserves stricter root permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoist-private-"));
  const outside = await mkdtemp(join(tmpdir(), "hoist-outside-"));
  try {
    await chmod(outside, 0o500);
    await symlink(outside, join(root, "tmp"));
    expect(() =>
      privatePath(join(root, "tmp", "child"), true, false, root),
    ).toThrow(
      `${join(root, "tmp")} is a symlink; hoist does not follow symlinks inside HOIST_DIR`,
    );
    expect((await stat(outside)).mode & 0o777).toBe(0o500);
    await chmod(root, 0o500);
    privatePath(root, true, false, root);
    expect((await stat(root)).mode & 0o777).toBe(0o500);
  } finally {
    await chmod(root, 0o700);
    await chmod(outside, 0o700);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("privatePath permits a symlink as HOIST_DIR itself and tightens permissive files and directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoist-modes-"));
  try {
    const real = join(root, "real"),
      alias = join(root, "alias");
    await mkdir(real);
    await symlink(real, alias);
    privatePath(alias, true, false, alias);
    const dir = join(alias, "dir"),
      file = join(dir, "file");
    await mkdir(dir);
    await chmod(dir, 0o755);
    await writeFile(file, "private");
    await chmod(file, 0o644);
    privatePath(file, false, false, alias);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlink Dockerfile is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoist-dockerfile-"));
  try {
    await writeFile(join(root, "target"), "FROM scratch\n");
    await symlink("target", join(root, "Dockerfile"));
    await expect(requireDockerfile(root)).rejects.toThrow(
      "Missing root Dockerfile",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent create loser maps exclusive directory EEXIST without cleaning the winner", async () => {
  const store = new FakeStore();
  let cleaned = false;
  await expect(
    createApp(
      store,
      "hello",
      "hello.test",
      "/",
      async () => {
        throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      },
      async () => {
        cleaned = true;
      },
    ),
  ).rejects.toThrow("App already exists");
  expect(cleaned).toBe(false);
  expect(store.apps()).toEqual([]);
});

test("CLI lowercases an explicit domain", () => {
  expect(
    parseCli(["apps:create", "hello", "--domain", "Hello.Example.COM"]).domain,
  ).toBe("hello.example.com");
});

test("Docker socket connection failure explains socket and group access", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoist-socket-"));
  try {
    const socket = join(root, "missing.sock");
    await expect(new Docker(socket).ping()).rejects.toThrow(
      `cannot reach Docker at ${socket}:`,
    );
    await expect(new Docker(socket).ping()).rejects.toThrow(
      "is this user in the docker group?",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("receive rejects non-commit objects before reserving or preparing", async () => {
  const store = new FakeStore(),
    docker = new FakeDocker();
  const app = store.createApp("hello", "hello.test", "/");
  let prepared = false;
  await expect(
    receive(
      "/unused",
      store,
      docker,
      app,
      `${zero} ${sha} refs/heads/main\n`,
      new AbortController().signal,
      async () => {
        prepared = true;
        throw new Error("unexpected checkout");
      },
      { objectType: async () => "tree", head: async () => null },
    ),
  ).rejects.toThrow("pushed object is not a commit");
  expect(prepared).toBe(false);
  expect(store.rows).toEqual([]);
  expect(docker.calls).toEqual([]);
});

test("receive detects branch movement after building and removes the rejected image", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoist-ref-"));
  const store = new FakeStore(),
    docker = new FakeDocker();
  const app = store.createApp("hello", "hello.test", "/");
  try {
    await writeFile(join(root, "Dockerfile"), "FROM scratch\n");
    await expect(
      receive(
        root,
        store,
        docker,
        app,
        `${zero} ${sha} refs/heads/main\n`,
        new AbortController().signal,
        async () => ({ path: root, cleanup: async () => {} }),
        { objectType: async () => "commit", head: async () => "b".repeat(40) },
      ),
    ).rejects.toThrow("branch main moved during build; push again");
    expect(store.rows[0]?.status).toBe("failed");
    expect(docker.images.size).toBe(0);
    expect(
      await readdir(join(root, "releases", "hello", "main", "v1")),
    ).toEqual(["build.log"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("receive accepts an unchanged existing branch and checks it before marking built", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoist-ref-ok-"));
  const store = new FakeStore(),
    docker = new FakeDocker();
  const app = store.createApp("hello", "hello.test", "/");
  const old = "b".repeat(40);
  let checked = false;
  try {
    await writeFile(join(root, "Dockerfile"), "FROM scratch\n");
    await receive(
      root,
      store,
      docker,
      app,
      `${old} ${sha} refs/heads/main\n`,
      new AbortController().signal,
      async () => ({ path: root, cleanup: async () => {} }),
      {
        objectType: async () => "commit",
        head: async () => {
          expect(store.rows[0]?.status).toBe("building");
          expect(docker.images.size).toBe(1);
          checked = true;
          return old;
        },
      },
    );
    expect(checked).toBe(true);
    expect(store.rows[0]?.status).toBe("built");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
