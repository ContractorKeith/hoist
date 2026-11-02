import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Docker } from "../../src/adapters/docker";
import { DashboardStore } from "../../src/store/dashboard";
import { SqliteStore } from "../../src/store/sqlite";
import {
  beforeInstall,
  checkDomainNormalization,
  checkInstalledFiles,
  downloadGuards,
  installerCommands,
  signalCleanup,
} from "./install-guards";
import { command, ok } from "./ssh";

test.skipIf(process.env.HOIST_E2E !== "1")(
  "fresh Ubuntu installer validates guards, installs the owner key and preserves upgrades",
  async () => {
    try {
      await new Docker().ping();
    } catch {
      throw new Error(
        "HOIST_E2E=1 requires Linux and a reachable Docker daemon",
      );
    }
    await ok(["bun", "run", "build"]);
    const name = `hoist-install-${crypto.randomUUID()}`;
    const scratch = await mkdtemp(join(tmpdir(), "install-fixture-"));
    try {
      await ok([
        "docker",
        "run",
        "-d",
        "--platform",
        `linux/${process.arch === "x64" ? "amd64" : "arm64"}`,
        "--name",
        name,
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "ubuntu:24.04",
        "sleep",
        "infinity",
      ]);
      await ok(["docker", "cp", resolve("dist/hoist"), `${name}:/local-hoist`]);
      await ok(["docker", "cp", resolve("install.sh"), `${name}:/install.sh`]);
      await ok([
        "docker",
        "cp",
        resolve("test/fixtures/installer-owner.pub"),
        `${name}:/owner.pub`,
      ]);
      await beforeInstall(name);
      await checkDomainNormalization(name);
      const install = [
        "docker",
        "exec",
        "-e",
        "HOIST_LOCAL_BINARY=/local-hoist",
        "-e",
        "HOIST_E2E=1",
        "-e",
        "HOIST_DOMAIN=example.test",
        "-e",
        "HOIST_ACME_EMAIL=owner@example.test",
        "-e",
        "HOIST_DOCTOR_NO_SERVICE=1",
        name,
        "sh",
        "/install.sh",
        "--key",
        "/owner.pub",
      ];
      const first = await command(install);
      if (first.code) throw new Error(first.output);
      expect(first.output).toContain("Running hoist doctor.");
      expect(first.code).toBe(0);
      const { inside, invoke } = installerCommands(name);
      expect(first.output).toContain(
        "Fix the items above and rerun hoist doctor.",
      );
      const authorized = await checkInstalledFiles(name, first.stdout);
      await inside(
        "sh",
        "-c",
        "printf 'installer-test-password\\n' | runuser -u hoist -- /usr/local/bin/hoist dashboard:set-password",
      );
      const control = (...args: string[]) =>
        inside(
          "runuser",
          "-u",
          "hoist",
          "--",
          "env",
          "HOIST_DOMAIN=example.test",
          "HOIST_DOCTOR_NO_SERVICE=1",
          "/usr/local/bin/hoist",
          ...args,
        );
      await control("apps:create", "install-test");
      await control("config:set", "install-test", "KEPT=upgrade");
      await inside(
        "sh",
        "-c",
        "printf '#!/bin/sh\\nexec /old/hoist\\n' > /var/lib/hoist/repos/install-test.git/hooks/pre-receive",
      );
      const doctor = await control("doctor", "--json");
      expect(doctor.stdout).toContain("/old/hoist");
      expect(
        (
          await inside(
            "cat",
            "/var/lib/hoist/repos/install-test.git/hooks/pre-receive",
          )
        ).stdout,
      ).toContain("/usr/local/bin/hoist");
      // Seed a historical failed release without a build; upgrades must preserve its snapshot.
      await ok([
        "docker",
        "cp",
        `${name}:/var/lib/hoist/hoist.db`,
        join(scratch, "hoist.db"),
      ]);
      const fixture = new SqliteStore(scratch);
      const password = new DashboardStore(fixture.db).password();
      const app = fixture.app("install-test");
      if (!app) throw new Error("Missing installed app");
      fixture.insertRelease({
        app_id: app.id,
        branch: "main",
        number: 1,
        git_sha: "a".repeat(40),
        image: "hoist/install-test:main-v1-fixture",
        config_json: "{}",
        status: "failed",
      });
      fixture.close();
      await ok([
        "docker",
        "cp",
        join(scratch, "hoist.db"),
        `${name}:/var/lib/hoist/hoist.db`,
      ]);
      await inside("chown", "hoist:hoist", "/var/lib/hoist/hoist.db");
      const releases = (await control("releases", "install-test", "--json"))
        .stdout;
      const before = (await inside("cat", "/etc/hoist/hoist.env")).stdout;
      const upgrade = await invoke([
        "HOIST_LOCAL_BINARY=/local-hoist",
        "HOIST_E2E=1",
        "HOIST_DOCTOR_NO_SERVICE=1",
        "HOIST_OWNER_PASSWORD=must-not-reset",
      ]);
      if (upgrade.code) throw new Error(upgrade.output);
      expect(upgrade.code).toBe(0);
      expect(
        (await inside("cat", "/var/lib/hoist/.ssh/authorized_keys")).stdout,
      ).toBe(authorized);
      await ok([
        "docker",
        "cp",
        `${name}:/var/lib/hoist/hoist.db`,
        join(scratch, "hoist.db"),
      ]);
      const upgraded = new SqliteStore(scratch);
      try {
        expect(new DashboardStore(upgraded.db).password()).toBe(password);
      } finally {
        upgraded.close();
      }
      expect((await inside("cat", "/etc/hoist/hoist.env")).stdout).toBe(before);
      expect(
        (await control("config:list", "install-test", "--reveal", "--json"))
          .stdout,
      ).toContain("upgrade");
      expect((await control("doctor")).code).toBe(0);
      expect((await control("releases", "install-test", "--json")).stdout).toBe(
        releases,
      );
      const arch = process.arch === "x64" ? "x64" : "arm64";
      const digest = new Bun.CryptoHasher("sha256")
        .update(await Bun.file("dist/hoist").arrayBuffer())
        .digest("hex");
      await downloadGuards(name, arch, digest);
      await signalCleanup(name);
      await control("apps:destroy", "install-test", "--force");
    } finally {
      await command(["docker", "rm", "-f", name]);
      await rm(scratch, { recursive: true, force: true });
    }
  },
  600000,
);
