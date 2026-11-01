import { expect, test } from "bun:test";
import { resolve } from "node:path";
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
