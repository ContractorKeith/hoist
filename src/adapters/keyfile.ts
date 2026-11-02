import { constants } from "node:fs";
import { link, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { privatePath } from "../data";

export async function keyfile(root: string): Promise<CryptoKey> {
  privatePath(root, true, false, root);
  const path = join(root, "secret.key");
  const read = () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    file = await read();
  }
  try {
    await file.chmod(0o600);
    const bytes = await file.readFile();
    if (bytes.length !== 32)
      throw new Error("secret.key must contain exactly 32 bytes.");
    return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  } finally {
    await file.close();
  }
}
