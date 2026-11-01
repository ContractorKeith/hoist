import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { version } from "../../package.json";

test("hoist version prints package version and rejects unknown verbs", async () => {
  const cliPath = resolve(import.meta.dir, "../../src/cli/index.ts");
  const cli = Bun.spawn([process.execPath, cliPath, "version"], {
    stdout: "pipe",
  });
  expect(await new Response(cli.stdout).text()).toBe(`${version}\n`);
  expect(await cli.exited).toBe(0);
  const unknown = Bun.spawn([process.execPath, cliPath, "unknown"], {
    stderr: "pipe",
  });
  expect(await new Response(unknown.stderr).text()).toContain("Usage:");
  expect(await unknown.exited).toBe(1);
});

test("SSH cannot invoke internal hook or recursively dispatch", async () => {
  for (const command of [
    "hoist ssh-dispatch",
    "git-hook pre-receive hello",
    "hoist serve",
  ]) {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../../src/cli/index.ts"),
        "ssh-dispatch",
      ],
      {
        env: { ...process.env, SSH_ORIGINAL_COMMAND: command },
        stderr: "pipe",
      },
    );
    expect(await new Response(child.stderr).text()).toContain("Usage:");
    expect(await child.exited).toBe(1);
  }
});

test("CLI explains missing domain and rejects an option in place of an app name", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoist-cli-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOIST_DIR: root };
  delete env.HOIST_DOMAIN;
  try {
    for (const [args, message] of [
      [
        ["apps:create", "hello"],
        "HOIST_DOMAIN is not set; pass --domain or set HOIST_DOMAIN",
      ],
      [["apps:destroy", "--force"], "Usage:"],
    ] as const) {
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../../src/cli/index.ts"),
          ...args,
        ],
        { env, stderr: "pipe" },
      );
      expect(await new Response(child.stderr).text()).toContain(message);
      expect(await child.exited).toBe(1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
