import { expect, test } from "bun:test";
import { version } from "../../package.json";

test("hoist version prints package version and rejects unknown verbs", async () => {
  const cli = Bun.spawn([process.execPath, "src/cli/index.ts", "version"], {
    stdout: "pipe",
  });
  expect(await new Response(cli.stdout).text()).toBe(`${version}\n`);
  expect(await cli.exited).toBe(0);
  const unknown = Bun.spawn([process.execPath, "src/cli/index.ts", "unknown"], {
    stderr: "pipe",
  });
  expect(await new Response(unknown.stderr).text()).toContain("Usage:");
  expect(await unknown.exited).toBe(1);
});
