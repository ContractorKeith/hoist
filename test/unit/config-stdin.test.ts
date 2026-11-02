import { expect, test } from "bun:test";
import { FakeStore } from "../../src/adapters/fakes/store";
import { configCommand, configValues } from "../../src/cli/config";
import { decryptConfig } from "../../src/core/secrets";
import { commandArgs } from "../../src/git/dispatch";

const input = (value: string) => new Blob([value]).stream();
test("config stdin preserves multiline values, strips one newline and encrypts under KEY", async () => {
  const store = new FakeStore();
  const app = store.createApp("hello", "hello.test", "/");
  await configCommand(
    store,
    ["config:set", "hello", "PEM", "--stdin"],
    () => {},
    input("l1\nl2\n\n"),
  );
  expect(
    await decryptConfig(store, app.id, JSON.stringify(store.config(app.id))),
  ).toEqual({ PEM: "l1\nl2\n" });
  expect(
    await configValues(["KEY", "--stdin"], input("x".repeat(65536))),
  ).toEqual([["KEY", "x".repeat(65536)]]);
});
test("config stdin rejects empty, oversized, NUL and malformed arguments", async () => {
  for (const value of ["", "\n", "x".repeat(65537), "a\0b"])
    await expect(
      configValues(["KEY", "--stdin"], input(value)),
    ).rejects.toThrow();
  for (const args of [
    ["--stdin"],
    ["KEY", "--stdin", "OTHER=x"],
    ["bad", "--stdin"],
  ])
    await expect(configValues(args, input("value"))).rejects.toThrow();
});
test("SSH control characters and oversized commands explain stdin", () => {
  for (const value of [
    "hoist config:set hello KEY=a\nb",
    "x".repeat(8193),
    "a\tb",
  ])
    expect(() => commandArgs(value)).toThrow("use config:set KEY --stdin");
});
