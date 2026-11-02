import type { Store } from "../store/interface";

export async function encrypt(
  key: CryptoKey,
  value: string,
  appId: number,
  name: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(`${appId}:${name}`),
    },
    key,
    new TextEncoder().encode(value),
  );
  return `v1:${Buffer.from(iv).toString("base64")}:${Buffer.from(ciphertext).toString("base64")}`;
}

export async function decrypt(
  key: CryptoKey,
  value: string,
  appId: number,
  name: string,
): Promise<string> {
  try {
    const [version, iv, ciphertext, extra] = value.split(":");
    if (version !== "v1" || !iv || !ciphertext || extra !== undefined)
      throw new Error("Invalid ciphertext");
    const nonce = Buffer.from(iv, "base64");
    if (nonce.length !== 12) throw new Error("Invalid IV");
    return new TextDecoder().decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: new TextEncoder().encode(`${appId}:${name}`),
        },
        key,
        Buffer.from(ciphertext, "base64"),
      ),
    );
  } catch {
    throw new Error(
      "Cannot decrypt config; secret.key is wrong or the stored value was damaged.",
    );
  }
}

export async function decryptConfig(
  store: Store,
  appId: number,
  snapshot: string,
): Promise<Record<string, string>> {
  const entries = Object.entries(
    JSON.parse(snapshot) as Record<string, string>,
  );
  if (!entries.length) return {};
  const key = await store.secretKey();
  return Object.fromEntries(
    await Promise.all(
      entries.map(async ([name, value]) => [
        name,
        await decrypt(key, value, appId, name),
      ]),
    ),
  );
}

// Check current and historical values before introducing any new ciphertext.
export async function validateConfigKey(store: Store): Promise<CryptoKey> {
  const key = await store.secretKey(true);
  for (const app of store.apps()) {
    const snapshots = [
      JSON.stringify(store.config(app.id)),
      ...store.releases(app.id).map((row) => row.config_json),
    ];
    for (const snapshot of snapshots) {
      for (const [name, value] of Object.entries(
        JSON.parse(snapshot) as Record<string, string>,
      )) {
        await decrypt(key, value, app.id, name);
      }
    }
  }
  return key;
}
