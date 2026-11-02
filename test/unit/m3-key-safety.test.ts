import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeStore } from "../../src/adapters/fakes/store";
import { configCommand } from "../../src/cli/config";
import { reserveRelease } from "../../src/core/build";
import { decryptConfig } from "../../src/core/secrets";
import { SqliteStore } from "../../src/store/sqlite";

for (const onlySnapshot of [false, true]) {
  test(`missing key refuses regeneration with ${onlySnapshot ? "only a release snapshot" : "current config"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "m3-missing-"));
    let store = new SqliteStore(root);
    try {
      const app = store.createApp("hello", "hello.test", "/");
      await configCommand(
        store,
        ["config:set", "hello", "A=original"],
        () => {},
      );
      if (onlySnapshot) {
        reserveRelease(store, app, "main", "a".repeat(40));
        store.unsetConfig(app.id, "A");
      }
      store.close();
      await rm(join(root, "secret.key"));
      store = new SqliteStore(root);
      await expect(store.secretKey()).rejects.toThrow(
        "secret.key is missing but encrypted config exists; restore the key from backup",
      );
      await expect(
        configCommand(store, ["config:set", "hello", "B=new"], () => {}),
      ).rejects.toThrow("secret.key is missing");
      expect(store.config(app.id).B).toBeUndefined();
      expect(await stat(join(root, "secret.key")).catch(() => null)).toBeNull();
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("replaced key refuses config writes even with only historical ciphertext remaining", async () => {
  const root = await mkdtemp(join(tmpdir(), "m3-replaced-"));
  let store = new SqliteStore(root);
  try {
    const app = store.createApp("hello", "hello.test", "/");
    await configCommand(store, ["config:set", "hello", "A=original"], () => {});
    const release = reserveRelease(store, app, "main", "a".repeat(40));
    const original = store.config(app.id);
    store.close();
    await writeFile(
      join(root, "secret.key"),
      crypto.getRandomValues(new Uint8Array(32)),
    );
    store = new SqliteStore(root);
    await expect(
      configCommand(
        store,
        ["config:set", "hello", "A=replacement", "B=new"],
        () => {},
      ),
    ).rejects.toThrow("Cannot decrypt config;");
    expect(store.config(app.id)).toEqual(original);
    store.unsetConfig(app.id, "A");
    await expect(
      configCommand(store, ["config:set", "hello", "B=new"], () => {}),
    ).rejects.toThrow("Cannot decrypt config;");
    expect(store.config(app.id)).toEqual({});
    await expect(
      decryptConfig(store, app.id, release.config_json),
    ).rejects.toThrow("Cannot decrypt config;");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("config:set refuses an existing damaged row, including overwriting that row", async () => {
  const store = new FakeStore(),
    app = store.createApp("hello", "hello.test", "/");
  store.setConfig(app.id, "A", "v1:damaged:ciphertext");
  await expect(
    configCommand(
      store,
      ["config:set", "hello", "A=overwrite", "B=new"],
      () => {},
    ),
  ).rejects.toThrow("Cannot decrypt config;");
  expect(store.config(app.id)).toEqual({ A: "v1:damaged:ciphertext" });
});

test("FIFO secret.key fails within one second without blocking", async () => {
  const root = await mkdtemp(join(tmpdir(), "m3-fifo-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    expect(await Bun.spawn(["mkfifo", join(root, "secret.key")]).exited).toBe(
      0,
    );
    const module = resolve(import.meta.dir, "../../src/adapters/keyfile.ts");
    const script = `import {keyfile} from ${JSON.stringify(module)}; try { await keyfile(${JSON.stringify(root)}); } catch (error) { console.error(error.message); process.exitCode = 1; }`;
    const launched = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    child = launched;
    const code = await Promise.race([
      launched.exited,
      Bun.sleep(1000).then(() => {
        throw new Error("keyfile hung on FIFO");
      }),
    ]);
    expect(code).toBe(1);
    expect(await new Response(launched.stderr).text()).toContain(
      "secret.key must be a regular file",
    );
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

for (const removed of [false, true]) {
  test(`a cached key does not hide a ${removed ? "deleted" : "replaced"} key file`, async () => {
    const root = await mkdtemp(join(tmpdir(), "m3-cached-key-"));
    const store = new SqliteStore(root);
    try {
      const app = store.createApp("hello", "hello.test", "/");
      await configCommand(
        store,
        ["config:set", "hello", "A=original"],
        () => {},
      );
      const original = store.config(app.id);
      if (removed) await rm(join(root, "secret.key"));
      else
        await writeFile(
          join(root, "secret.key"),
          crypto.getRandomValues(new Uint8Array(32)),
        );
      await expect(
        configCommand(store, ["config:set", "hello", "B=new"], () => {}),
      ).rejects.toThrow(
        removed
          ? "secret.key is missing but encrypted config exists"
          : "Cannot decrypt config;",
      );
      expect(store.config(app.id)).toEqual(original);
      if (removed)
        expect(
          await stat(join(root, "secret.key")).catch(() => null),
        ).toBeNull();
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("an unused cached key can be regenerated while no encrypted data exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "m3-unused-key-"));
  const store = new SqliteStore(root);
  try {
    const app = store.createApp("hello", "hello.test", "/");
    await store.secretKey();
    await rm(join(root, "secret.key"));
    await configCommand(
      store,
      ["config:set", "hello", "A=first value"],
      () => {},
    );
    expect(
      await decryptConfig(store, app.id, JSON.stringify(store.config(app.id))),
    ).toEqual({ A: "first value" });
    expect((await stat(join(root, "secret.key"))).size).toBe(32);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
