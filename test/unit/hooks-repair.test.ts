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

test("hook repair removes stale staging files before replacing the hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "stale-hooks-"));
  try {
    await createRepo(root, "stale");
    const directory = join(root, "repos/stale.git/hooks");
    await Bun.write(
      join(directory, "pre-receive"),
      "#!/bin/sh\nexec /old/hoist\n",
    );
    for (const file of [
      ".pre-receive.next",
      ".pre-receive.2147483647.abandoned.next",
      ".pre-receive.9999999999999999.abandoned.next",
      `.post-receive.${process.pid}.abandoned.next`,
    ])
      await Bun.write(join(directory, file), "partial");
    await rewriteHooks(root, "stale");
    expect(await Bun.file(join(directory, "pre-receive")).text()).toBe(
      `#!/bin/sh\nexec ${executableCommand()} git-hook pre-receive 'stale'\n`,
    );
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".next")),
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two concurrent hook repairs both resolve and leave complete hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "concurrent-hooks-"));
  try {
    await createRepo(root, "concurrent");
    const directory = join(root, "repos/concurrent.git/hooks");
    for (let attempt = 0; attempt < 10; attempt++) {
      for (const hook of ["pre-receive", "post-receive"])
        await Bun.write(join(directory, hook), "#!/bin/sh\nexec /old/hoist\n");
      await Promise.all([
        rewriteHooks(root, "concurrent"),
        rewriteHooks(root, "concurrent"),
      ]);
      for (const hook of ["pre-receive", "post-receive"])
        expect(await Bun.file(join(directory, hook)).text()).toBe(
          `#!/bin/sh\nexec ${executableCommand()} git-hook ${hook} 'concurrent'\n`,
        );
      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".next")),
      ).toEqual([]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hook repair skips an empty dot-git directory without creating hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "non-repo-hooks-"));
  try {
    await mkdir(join(root, "repos/aaa.git"), { recursive: true });
    expect(await repairRepoHooks(root)).toContain(
      "skipped aaa.git: not a bare repository",
    );
    expect(
      await stat(join(root, "repos/aaa.git/hooks")).catch(() => null),
    ).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
