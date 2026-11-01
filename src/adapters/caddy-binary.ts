import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Official v2.11.7 Linux archives and the caddy binaries extracted from them.
// Source: https://github.com/caddyserver/caddy/releases/tag/v2.11.7
export const caddyRelease = {
  version: "2.11.7",
  linux: {
    x64: {
      arch: "amd64",
      archiveSha256:
        "727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b",
      binarySha256:
        "678ade3bfc088749c81a681adc603333ee0bb023b6a6cfe3c0f58bef8ff854e9",
    },
    arm64: {
      arch: "arm64",
      archiveSha256:
        "d8fc6d179a5d283028a472a5618564f6ad8a86fed513e64f032b3b0b7cc45e42",
      binarySha256:
        "0019d864a2cdee41c3675cb2a26185833c5d9540a48f5a6729142c0413461b60",
    },
  },
} as const;

async function sha256(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256")
    .update(await Bun.file(path).arrayBuffer())
    .digest("hex");
}

export async function ensureCaddy(): Promise<string> {
  if (process.platform !== "linux" || !(process.arch in caddyRelease.linux))
    throw new Error("Caddy pin supports Linux amd64 and arm64");
  const pin =
    caddyRelease.linux[process.arch as keyof typeof caddyRelease.linux];
  const directory = join(homedir(), ".cache/hoist/caddy", caddyRelease.version);
  const binary = join(directory, "caddy");
  if (
    (await Bun.file(binary).exists()) &&
    (await sha256(binary)) === pin.binarySha256
  ) {
    await chmod(binary, 0o755);
    return binary;
  }
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, ".download-"));
  try {
    const name = `caddy_${caddyRelease.version}_linux_${pin.arch}.tar.gz`;
    const response = await fetch(
      `https://github.com/caddyserver/caddy/releases/download/v${caddyRelease.version}/${name}`,
      { signal: AbortSignal.timeout(60000) },
    );
    if (!response.ok) throw new Error(`Caddy download: ${response.status}`);
    const archive = join(staging, "archive.tar.gz");
    await Bun.write(archive, response);
    if ((await sha256(archive)) !== pin.archiveSha256)
      throw new Error("Caddy archive checksum mismatch");
    const extraction = Bun.spawn(
      ["tar", "-xzf", archive, "-C", staging, "caddy"],
      { stdout: "ignore", stderr: "pipe" },
    );
    const errors = new Response(extraction.stderr).text();
    if ((await extraction.exited) !== 0)
      throw new Error(`Caddy extraction: ${await errors}`);
    await errors;
    const extracted = join(staging, "caddy");
    if ((await sha256(extracted)) !== pin.binarySha256)
      throw new Error("Caddy binary checksum mismatch");
    await chmod(extracted, 0o755);
    await rename(extracted, binary);
    return binary;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
