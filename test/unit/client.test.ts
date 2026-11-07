import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commandArgs } from "../../src/git/dispatch";
import { command, ok } from "../e2e/ssh";

test("Node client preserves exact ssh argv, host precedence and exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoist-client-"));
  try {
    const ssh = join(root, "ssh"),
      output = join(root, "argv.json");
    await Bun.write(
      ssh,
      `#!/bin/sh\nexec node -e 'require("fs").writeFileSync(process.env.ARGV_FILE, JSON.stringify(process.argv.slice(1))); process.exit(23);' -- "$@"\n`,
    );
    await chmod(ssh, 0o700);
    const env = {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      ARGV_FILE: output,
      HOIST_HOST: "default",
    };
    const cli = resolve("cli/bin/hoist.js");
    const args = [
      "config:set",
      "blog",
      "KEY=a b'\";$(touch nope)",
      "EMPTY=",
      "--json",
    ];
    expect(
      (await command(["node", cli, "--host", "test", ...args], { env })).code,
    ).toBe(23);
    const actual = (await Bun.file(output).json()) as string[];
    expect(actual[0]).toBe("hoist@test");
    expect(commandArgs(actual.slice(1).join(" "))).toEqual(["hoist", ...args]);
    expect((await command(["node", cli, "apps:list"], { env })).code).toBe(23);
    expect(await Bun.file(output).json()).toEqual([
      "hoist@default",
      "'hoist'",
      "'apps:list'",
    ]);
    expect(
      (
        await command(
          ["node", cli, "--host", "-oProxyCommand=oops", "apps:list"],
          { env },
        )
      ).code,
    ).toBe(1);
    expect((await ok(["node", cli, "--help"], { env })).stdout).toContain(
      "doctor [--json]",
    );
    // Exercise the same layout npm installs, without publishing or changing the host's global bin.
    const packed = await ok([
      "npm",
      "pack",
      resolve("cli"),
      "--pack-destination",
      root,
      "--json",
    ]);
    const filename = (JSON.parse(packed.stdout) as { filename: string }[])[0]
      ?.filename;
    if (!filename) throw new Error("npm pack produced no archive");
    await ok([
      "npm",
      "install",
      "--prefix",
      root,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(root, filename),
    ]);
    expect(
      (
        await command([join(root, "node_modules/.bin/hoist"), "apps:list"], {
          env,
        })
      ).code,
    ).toBe(23);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const) {
  test(`Node client maps ssh ${signal} to exit ${code}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "client-signal-"));
    try {
      await Bun.write(
        join(root, "ssh"),
        `#!/bin/sh\nkill -${signal.slice(3)} "$$"\n`,
      );
      await chmod(join(root, "ssh"), 0o700);
      const result = await command(
        ["node", resolve("cli/bin/hoist.js"), "--host", "test", "apps:list"],
        { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } },
      );
      expect(result.code).toBe(code);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("client help exposes only verbs available through SSH", async () => {
  const help = await ok(["node", resolve("cli/bin/hoist.js"), "--help"]);
  expect(help.stdout).not.toMatch(/\bserve\b|\bssh-dispatch\b|\bgit-hook\b/);
});

async function clientArgv(args: string[]): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "client-quoting-"));
  try {
    await Bun.write(
      join(root, "ssh"),
      `#!/bin/sh\nexec node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"\n`,
    );
    await chmod(join(root, "ssh"), 0o700);
    const result = await ok(
      ["node", resolve("cli/bin/hoist.js"), "--host", "test", ...args],
      { env: { ...process.env, PATH: `${root}:${process.env.PATH}` } },
    );
    return JSON.parse(result.stdout) as string[];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("client quotes spaces, apostrophes and empty strings in remote SSH argv", async () => {
  expect(
    await clientArgv(["config:set", "demo", "KEY=a OTHER=oops", "it's", ""]),
  ).toEqual([
    "hoist@test",
    "'hoist'",
    "'config:set'",
    "'demo'",
    "'KEY=a OTHER=oops'",
    "'it'\"'\"'s'",
    "''",
  ]);
});

test("client remote command round-trips through the server tokenizer without splitting config values", async () => {
  const original = ["config:set", "demo", "KEY=a OTHER=oops", "it's", ""];
  const argv = await clientArgv(original);
  expect(commandArgs(argv.slice(1).join(" "))).toEqual(["hoist", ...original]);
});
