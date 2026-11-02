import { constants } from "node:fs";
import { link, lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { privatePath } from "../data";

const fingerprints = new WeakMap<CryptoKey, string>();
async function fingerprint(bytes: Uint8Array): Promise<string> {
  return Buffer.from(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  ).toString("hex");
}

async function readRegular(path: string) {
  if (!(await lstat(path)).isFile())
    throw new Error("secret.key must be a regular file");
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await file.stat()).isFile())
      throw new Error("secret.key must be a regular file");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function keyfile(
  root: string,
  canCreate: () => boolean = () => true,
): Promise<CryptoKey> {
  privatePath(root, true, false, root);
  const path = join(root, "secret.key");
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await readRegular(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!canCreate())
      throw new Error(
        "secret.key is missing but encrypted config exists; restore the key from backup",
      );
    const temp = await mkdtemp(join(root, ".key-"));
    try {
      const candidate = join(temp, "key");
      await writeFile(candidate, crypto.getRandomValues(new Uint8Array(32)), {
        mode: 0o600,
      });
      // Linking publishes the complete key atomically and never replaces a winner.
      await link(candidate, path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    file = await readRegular(path);
  }
  try {
    await file.chmod(0o600);
    const bytes = await file.readFile();
    if (bytes.length !== 32)
      throw new Error("secret.key must contain exactly 32 bytes.");
    const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    fingerprints.set(key, await fingerprint(bytes));
    return key;
  } finally {
    await file.close();
  }
}

// Explicit safety checks use a fingerprint without re-importing or chmodding the cached key.
export async function verifyKeyfile(
  root: string,
  key: CryptoKey,
): Promise<void> {
  const file = await readRegular(join(root, "secret.key"));
  try {
    if ((await fingerprint(await file.readFile())) !== fingerprints.get(key))
      throw new Error(
        "Cannot decrypt config; secret.key is wrong or the stored value was damaged.",
      );
  } finally {
    await file.close();
  }
}
