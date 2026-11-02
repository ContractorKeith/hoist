import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Docker } from "../../src/adapters/docker";
import { SqliteStore } from "../../src/store/sqlite";
import { command, ok } from "./ssh";

test.skipIf(process.env.HOIST_E2E !== "1")(
  "fresh Ubuntu installer, doctor and upgrade preserve app data",
  async () => {
    try {
      await new Docker().ping();
    } catch {
      console.log("Installer e2e skipped: the Docker socket is unavailable.");
      return;
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
      const install = [
        "docker",
        "exec",
        "-e",
        "HOIST_LOCAL_BINARY=/local-hoist",
        "-e",
        "HOIST_DOMAIN=example.test",
        "-e",
        "HOIST_ACME_EMAIL=owner@example.test",
        "-e",
        "HOIST_OWNER_PASSWORD=installer-test-password",
        "-e",
        "HOIST_DOCTOR_NO_SERVICE=1",
        name,
        "sh",
        "/install.sh",
      ];
      const first = await command(install);
      if (first.code) throw new Error(first.output);
      expect(first.output).toContain("Running hoist doctor.");
      expect(first.code).toBe(0);
      const inside = (...args: string[]) =>
        ok(["docker", "exec", name, ...args]);
      expect(
        (await inside("cat", "/etc/systemd/system/hoist.service")).stdout,
      ).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
      expect(
        (
          await inside("stat", "-c", "%a", "/etc/hoist/hoist.env")
        ).stdout.trim(),
      ).toBe("600");
      expect((await inside("getent", "passwd", "hoist")).stdout).toContain(
        "/var/lib/hoist:/bin/sh",
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
      expect((await ok(install)).code).toBe(0);
      expect((await inside("cat", "/etc/hoist/hoist.env")).stdout).toBe(before);
      expect(
        (await control("config:list", "install-test", "--reveal", "--json"))
          .stdout,
      ).toContain("upgrade");
      expect((await control("doctor")).code).toBe(0);
      expect((await control("releases", "install-test", "--json")).stdout).toBe(
        releases,
      );
      await control("apps:destroy", "install-test", "--force");
    } finally {
      await command(["docker", "rm", "-f", name]);
      await rm(scratch, { recursive: true, force: true });
    }
  },
  600000,
);
