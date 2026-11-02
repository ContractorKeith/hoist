import { expect, test } from "bun:test";
import { mkdir, mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRepo,
  executableCommand,
  repairRepoHooks,
  rewriteHooks,
} from "../../src/git/repository";

test("hook repair atomically replaces the complete template and removes .next files", async () => {
  const root = await mkdtemp(join(tmpdir(), "atomic-hooks-"));
  try {
    await createRepo(root, "atomic");
    const directory = join(root, "repos/atomic.git/hooks");
    const path = join(directory, "pre-receive");
    const previous = "#!/bin/sh\nexec /old/hoist\n";
    await Bun.write(path, previous);
    const reader = await open(path, "r");
    try {
      const before = await reader.stat();
      await rewriteHooks(root, "atomic");
      expect(await reader.readFile("utf8")).toBe(previous);
      expect((await stat(path)).ino).not.toBe(before.ino);
      for (const hook of ["pre-receive", "post-receive"]) {
        expect(await Bun.file(join(directory, hook)).text()).toBe(
          `#!/bin/sh\nexec ${executableCommand()} git-hook ${hook} 'atomic'\n`,
        );
        expect((await stat(join(directory, hook))).mode & 0o777).toBe(0o700);
      }
      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".next")),
      ).toEqual([]);
    } finally {
      await reader.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hook repair skips invalid stray repo entries and repairs the valid repo", async () => {
  const root = await mkdtemp(join(tmpdir(), "stray-hooks-"));
  try {
    await createRepo(root, "valid");
    await mkdir(join(root, "repos/INVALID!.git"));
    await mkdir(join(root, "repos/scratch"));
    const path = join(root, "repos/valid.git/hooks/pre-receive");
    await Bun.write(path, "#!/bin/sh\nexec /wrong/hoist\n");
    const reports = await repairRepoHooks(root);
    expect(
      reports.some((line) => line.startsWith("skipped INVALID!.git: ")),
    ).toBe(true);
    expect(reports).toContain("skipped scratch: not a bare repository");
    expect(await Bun.file(path).text()).toContain(executableCommand());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
