import { expect } from "bun:test";
import { command, ok } from "./ssh";

export function installerCommands(name: string) {
  const inside = (...args: string[]) => ok(["docker", "exec", name, ...args]);
  const invoke = (
    env: string[],
    script = "/install.sh",
    key: boolean | string = true,
  ) =>
    command([
      "docker",
      "exec",
      ...env.flatMap((value) => ["-e", value]),
      name,
      "sh",
      script,
      ...(key ? ["--key", typeof key === "string" ? key : "/owner.pub"] : []),
    ]);
  return { inside, invoke };
}
export async function beforeInstall(name: string) {
  const { inside, invoke } = installerCommands(name);
  const missing = await invoke([], "/install.sh", false);
  expect(missing.code).toBe(1);
  expect(missing.output).toContain(
    "Set HOIST_DOMAIN for a non-interactive install",
  );
  const local = await invoke(
    ["HOIST_LOCAL_BINARY=/local-hoist"],
    "/install.sh",
    false,
  );
  expect(local.code).toBe(1);
  expect(local.output).toContain("HOIST_LOCAL_BINARY requires HOIST_E2E=1.");
  await inside("sh", "-c", "printf not-a-key > /bad-owner.pub");
  const env = [
    "HOIST_DOMAIN=example.test",
    "HOIST_ACME_EMAIL=owner@example.test",
  ];
  const invalid = await invoke(env, "/install.sh", "/bad-owner.pub");
  expect(invalid.code).toBe(1);
  expect(invalid.output).toContain("Provide one public SSH key.");
  await inside("touch", "/empty-owner.pub");
  const empty = await invoke(env, "/install.sh", "/empty-owner.pub");
  expect(empty.code).toBe(1);
  expect(empty.output).toContain("Provide one public SSH key.");
  const multiline = await invoke(
    [...env, "HOIST_OWNER_KEY=ssh-ed25519 AAA\nsecond-line"],
    "/install.sh",
    false,
  );
  expect(multiline.code).toBe(1);
  expect(multiline.output).toContain("Provide one public SSH key line.");
  await inside(
    "sh",
    "-c",
    "test ! -e /usr/bin/git && test ! -e /etc/apt/sources.list.d/docker.list && test ! -e /etc/hoist/hoist.env",
  );
  await inside("sh", "-c", "test ! -e /usr/local/bin/hoist");
}
export async function downloadGuards(
  name: string,
  arch: string,
  digest: string,
) {
  const { inside, invoke } = installerCommands(name);
  await inside("mkdir", "-p", "/fake-release");
  await inside("cp", "/local-hoist", `/fake-release/hoist-linux-${arch}`);
  await inside(
    "sh",
    "-c",
    `printf '%s  %s\\n' '${digest}' 'hoist-linux-${arch}' > /fake-release/checksums.txt`,
  );
  const env = [
    "HOIST_RELEASE_BASE=file:///fake-release",
    "HOIST_DOCTOR_NO_SERVICE=1",
  ];
  const downloaded = await invoke(env);
  if (downloaded.code) throw new Error(downloaded.output);
  expect(downloaded.output).toContain("checked against the release checksums");
  const before = (await inside("sha256sum", "/usr/local/bin/hoist")).stdout;
  await inside(
    "sh",
    "-c",
    `printf '%s  %s\\n' '${"0".repeat(64)}' 'hoist-linux-${arch}' > /fake-release/checksums.txt`,
  );
  const tampered = await invoke(env);
  expect(tampered.code).not.toBe(0);
  expect((await inside("sha256sum", "/usr/local/bin/hoist")).stdout).toBe(
    before,
  );
  // Installer pins override self-attesting metadata, including a corrupt checksums.txt.
  await inside(
    "sh",
    "-c",
    `sed 's/^HOIST_${arch.toUpperCase()}_SHA256=.*/HOIST_${arch.toUpperCase()}_SHA256=${digest}/' /install.sh > /install-pinned.sh`,
  );
  const pinned = await invoke(env, "/install-pinned.sh");
  if (pinned.code) throw new Error(pinned.output);
  expect(pinned.output).toContain("verified hoist");
  await inside(
    "sh",
    "-c",
    `printf tampered >> /fake-release/hoist-linux-${arch}`,
  );
  expect((await invoke(env, "/install-pinned.sh")).code).not.toBe(0);
  expect((await inside("sha256sum", "/usr/local/bin/hoist")).stdout).toBe(
    before,
  );
}

export async function signalCleanup(name: string) {
  const { inside, invoke } = installerCommands(name);
  await inside("mkdir", "-p", "/fakebin", "/trap-scratch");
  await inside(
    "sh",
    "-c",
    "printf '#!/bin/sh\\nkill -TERM \"$PPID\"\\nexit 0\\n' > /fakebin/curl; chmod 755 /fakebin/curl",
  );
  const interrupted = await invoke([
    "PATH=/fakebin:/usr/sbin:/usr/bin:/sbin:/bin",
    "TMPDIR=/trap-scratch",
    "HOIST_RELEASE_BASE=file:///fake-release",
  ]);
  expect(interrupted.code).toBe(130);
  expect(
    (await inside("find", "/trap-scratch", "-mindepth", "1", "-print")).stdout,
  ).toBe("");
}

export async function checkInstalledFiles(
  name: string,
  stdout: string,
): Promise<string> {
  const { inside } = installerCommands(name);
  const pubkey = (
    await Bun.file("test/fixtures/installer-owner.pub").text()
  ).trim();
  expect(stdout).not.toContain(pubkey);
  const authorized = (
    await inside("cat", "/var/lib/hoist/.ssh/authorized_keys")
  ).stdout;
  expect(authorized.trim()).toBe(
    `command="set -a; . /etc/hoist/hoist.env; set +a; exec /usr/local/bin/hoist ssh-dispatch",restrict ${pubkey}`,
  );
  for (const [path, mode] of [
    ["/var/lib/hoist/.ssh", "700"],
    ["/var/lib/hoist/.ssh/authorized_keys", "600"],
  ])
    expect(
      (await inside("stat", "-c", "%a:%U:%G", path ?? "")).stdout.trim(),
    ).toBe(`${mode}:hoist:hoist`);
  const unit = (await inside("cat", "/etc/systemd/system/hoist.service"))
    .stdout;
  for (const directive of [
    "AmbientCapabilities=CAP_NET_BIND_SERVICE",
    "NoNewPrivileges=yes",
    "ProtectSystem=full",
    "ProtectHome=yes",
    "PrivateTmp=yes",
    "ReadWritePaths=/var/lib/hoist",
  ])
    expect(unit).toContain(directive);
  expect(
    (await inside("stat", "-c", "%a", "/etc/hoist/hoist.env")).stdout.trim(),
  ).toBe("600");
  expect((await inside("getent", "passwd", "hoist")).stdout).toContain(
    "/var/lib/hoist:/bin/sh",
  );
  return authorized;
}

export async function checkDomainNormalization(name: string) {
  const { inside, invoke } = installerCommands(name);
  const result = await invoke([
    "HOIST_DOMAIN=Example.COM",
    "HOIST_ACME_EMAIL=owner@example.com",
    "HOIST_LOCAL_BINARY=/local-hoist",
    "HOIST_E2E=1",
    "HOIST_DOCTOR_NO_SERVICE=1",
  ]);
  if (result.code) throw new Error(result.output);
  expect(result.output).toContain("Lowercased HOIST_DOMAIN to example.com.");
  expect((await inside("cat", "/etc/hoist/hoist.env")).stdout).toContain(
    "HOIST_DOMAIN='example.com'",
  );
}
