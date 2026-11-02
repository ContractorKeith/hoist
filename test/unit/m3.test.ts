import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeStore } from "../../src/adapters/fakes/store";
import { keyfile } from "../../src/adapters/keyfile";
import { configCommand, parseValues } from "../../src/cli/config";
import { reserveRelease } from "../../src/core/build";
import { decrypt, decryptConfig, encrypt } from "../../src/core/secrets";
import { SqliteStore } from "../../src/store/sqlite";

function fixture() {
  const store = new FakeStore();
  const app = store.createApp("hello", "hello.example.test", "/");
  const release = () => reserveRelease(store, app, "main", "a".repeat(40));
  return { store, app, release };
}

test("AES-GCM round trip, random IVs, tamper and wrong key sentences", async () => {
  const store = new FakeStore(),
    key = await store.secretKey();
  const ciphertext = await encrypt(key, "sensitive=✓");
  expect(await decrypt(key, ciphertext)).toBe("sensitive=✓");
  expect(await encrypt(key, "sensitive=✓")).not.toBe(ciphertext);
  await expect(
    decrypt(await new FakeStore().secretKey(), ciphertext),
  ).rejects.toThrow("secret.key is wrong");
  const parts = ciphertext.split(":");
  const bytes = Buffer.from(parts[2] ?? "", "base64");
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  parts[2] = bytes.toString("base64");
  await expect(decrypt(key, parts.join(":"))).rejects.toThrow(
    "stored value was damaged.",
  );
});

test("key generated once, private mode, ciphertext only in SQLite and WAL", async () => {
  const root = await mkdtemp(join(tmpdir(), "m3-key-"));
  const store = new SqliteStore(root);
  try {
    const app = store.createApp("hello", "hello.test", "/");
    await configCommand(
      store,
      ["config:set", "hello", "A=unique-plaintext-✓-never-on-disk"],
      () => {},
    );
    const bytes = await readFile(join(root, "secret.key"));
    expect(bytes.length).toBe(32);
    expect((await stat(join(root, "secret.key"))).mode & 0o777).toBe(0o600);
    await keyfile(root);
    expect(await readFile(join(root, "secret.key"))).toEqual(bytes);
    const row = reserveRelease(store, app, "main", "a".repeat(40));
    expect(await decryptConfig(store, row.config_json)).toEqual({
      A: "unique-plaintext-✓-never-on-disk",
    });
    store.db.exec("PRAGMA wal_checkpoint(FULL)");
    for (const name of ["hoist.db", "hoist.db-wal"])
      expect(
        (await readFile(join(root, name))).includes(
          Buffer.from("unique-plaintext-✓-never-on-disk"),
        ),
      ).toBe(false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("config parsing, atomic refusal, masking without decrypting, reveal, unset", async () => {
  const { store, app, release } = fixture();
  expect(parseValues([`A=${"x".repeat(65536)}`])[0]?.[1].length).toBe(65536);
  expect(parseValues(["A=x=y", "_B="])).toEqual([
    ["A", "x=y"],
    ["_B", ""],
  ]);
  for (const args of [
    [],
    ["a=x"],
    ["1A=x"],
    ["A"],
    ["A=\0"],
    [`A=${"x".repeat(65537)}`],
  ])
    expect(() => parseValues(args)).toThrow();
  const lines: string[] = [],
    print = (line: string) => {
      lines.push(line);
    };
  await configCommand(store, ["config:set", "hello", "A=123", "B=✓"], print);
  expect(lines[0]).toContain("saved; the next push");
  const snapshot = release();
  await configCommand(store, ["config:set", "hello", "A=changed"], print);
  expect(await decryptConfig(store, snapshot.config_json)).toEqual({
    A: "123",
    B: "✓",
  });
  const secretKey = store.secretKey.bind(store);
  store.secretKey = async () => {
    throw new Error("masked listing must not load a key");
  };
  await configCommand(store, ["config:list", "hello", "--json"], print);
  expect(JSON.parse(lines.at(-1) ?? "")[0]).toEqual({
    key: "A",
    value: "••••",
    length: 7,
  });
  await configCommand(store, ["config:list", "hello"], print);
  expect(lines.at(-1)).toContain("A=•••• (7 bytes)");
  store.secretKey = secretKey;
  await configCommand(store, ["config:list", "hello", "--reveal"], print);
  expect(lines.at(-1)).toContain("A=changed");
  await expect(
    configCommand(store, ["config:set", "hello", "C=ok", "bad=x"], print),
  ).rejects.toThrow();
  expect(store.config(app.id).C).toBeUndefined();
  await configCommand(store, ["config:unset", "hello", "A"], print);
  expect(store.config(app.id).A).toBeUndefined();
  await expect(
    configCommand(store, ["config:list", "missing"], print),
  ).rejects.toThrow("Unknown app");
});

test("concurrent first use publishes one complete key", async () => {
  const root = await mkdtemp(join(tmpdir(), "m3-race-"));
  try {
    const keys = await Promise.all(
      Array.from({ length: 8 }, () => keyfile(root)),
    );
    const ciphertext = await encrypt(keys[0] as CryptoKey, "one winner");
    for (const key of keys)
      expect(await decrypt(key, ciphertext)).toBe("one winner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
