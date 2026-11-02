import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, ok } from "../e2e/ssh";

for (const tag of ["v0.2.0", "v0.1.0-rc", "v0.2.0-rc.1", "v0.2.0-beta.1"]) {
  test(`release assembly pins binaries and selects changelog notes for ${tag}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "release-assembly-"));
    try {
      const workflow = await Bun.file(".github/workflows/release.yml").text();
      const block = workflow
        .split("      - name: Assemble checksums and release notes\n")[1]
        ?.split("      - name: Run arm64 binary")[0];
      const script = block
        ?.split("        run: |\n")[1]
        ?.replace(/^ {10}/gm, "");
      if (!script) throw new Error("Missing release assembly step");
      await mkdir(join(root, ".tmp"));
      const version = tag.slice(1).split("-")[0];
      await Bun.write(join(root, "package.json"), JSON.stringify({ version }));
      const validation = workflow
        .split("      - name: Validate release tag\n")[1]
        ?.split("      - run:")[0]
        ?.split("        run: |\n")[1]
        ?.replace(/^ {10}/gm, "");
      if (!validation) throw new Error("Missing tag validation");
      await ok(["sh", "-c", validation], {
        cwd: root,
        env: { ...process.env, GITHUB_REF_NAME: tag },
      });
      expect(
        (
          await command(["sh", "-c", validation], {
            cwd: root,
            env: { ...process.env, GITHUB_REF_NAME: "v9.9.9" },
          })
        ).code,
      ).not.toBe(0);
      for (const invalid of [
        "v0.2.0/invalid",
        "v0.2.0-rc/invalid",
        "v0.2.0-",
      ]) {
        expect(
          (
            await command(["sh", "-c", validation], {
              cwd: root,
              env: { ...process.env, GITHUB_REF_NAME: invalid },
            })
          ).code,
        ).not.toBe(0);
      }
      const x64 = join(root, ".tmp/hoist-linux-x64");
      await Bun.write(x64, "#!/bin/sh\nprintf '0.2.0\\n'\n");
      await chmod(x64, 0o700);
      await Bun.write(join(root, ".tmp/hoist-linux-arm64"), "arm64 fixture");
      await Bun.write(
        join(root, "CHANGELOG.md"),
        "# Changes\n\n## 0.2.0\n\nNew release notes.\n\n## 0.1.0\n\nOld notes.\n",
      );
      const installer = await Bun.file("install.sh").text();
      expect(installer).toContain("HOIST_X64_SHA256=\nHOIST_ARM64_SHA256=\n");
      await Bun.write(join(root, "install.sh"), installer);
      await ok(["sh", "-c", script], {
        cwd: root,
        env: { ...process.env, GITHUB_REF_NAME: tag },
      });
      expect((await Bun.file(join(root, ".tmp/notes.md")).text()).trim()).toBe(
        version === "0.2.0" ? "New release notes." : "Old notes.",
      );
      const pinned = await Bun.file(join(root, "install.sh")).text();
      expect(pinned).toContain(`HOIST_VERSION=\${HOIST_VERSION:-${tag}}`);
      expect(pinned).toContain(`# Hoist ${tag}:`);
      expect(pinned).toContain(`HOIST_PINNED_VERSION=${tag}\n`);
      const defaultVersion = (
        await ok(
          [
            "sh",
            "-c",
            pinned.split("# BEGIN HOIST PINS")[0] +
              '\nprintf "%s" "$HOIST_VERSION"',
          ],
          { env: { ...process.env, HOIST_VERSION: "" } },
        )
      ).stdout;
      expect(defaultVersion).toBe(tag);
      const publish = workflow
        .split("      - name: Publish release\n")[1]
        ?.split("        run: |\n")[1]
        ?.replace(/^ {10}/gm, "");
      if (!publish) throw new Error("Missing publish step");
      await Bun.write(join(root, "gh"), '#!/bin/sh\nprintf "%s\\n" "$@"\n');
      await chmod(join(root, "gh"), 0o700);
      const published = await ok(["sh", "-c", publish], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          GITHUB_REF_NAME: tag,
        },
      });
      expect(published.stdout.split("\n").includes("--prerelease")).toBe(
        tag.includes("-"),
      );
      for (const arch of ["x64", "arm64"]) {
        const digest = new Bun.CryptoHasher("sha256")
          .update(
            await Bun.file(
              join(root, `.tmp/hoist-linux-${arch}`),
            ).arrayBuffer(),
          )
          .digest("hex");
        expect(pinned).toContain(
          `HOIST_${arch.toUpperCase()}_SHA256=${digest}\n`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
