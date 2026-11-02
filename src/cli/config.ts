import { knownApp } from "../core/apps";
import { decrypt, encrypt } from "../core/secrets";
import { appName } from "../core/validation";
import type { Store } from "../store/interface";

export function configKey(key: string): string {
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key))
    throw new Error(
      "Config keys must be uppercase identifiers of 1 to 128 characters.",
    );
  return key;
}
export function parseValues(args: string[]): [string, string][] {
  if (!args.length) throw new Error("config:set requires K=V values.");
  return args.map((arg) => {
    const split = arg.indexOf("=");
    if (split < 1) throw new Error("config:set requires K=V values.");
    const key = configKey(arg.slice(0, split)),
      value = arg.slice(split + 1);
    if (Buffer.byteLength(value) > 65536 || value.includes("\0"))
      throw new Error(
        "Config values must be at most 64 KiB and contain no NUL.",
      );
    return [key, value];
  });
}
export async function configCommand(
  store: Store,
  args: string[],
  print = console.log,
): Promise<void> {
  const [verb, name, ...rest] = args;
  const app = knownApp(store, appName(name ?? ""));
  if (verb === "config:set") {
    const values = parseValues(rest),
      key = await store.secretKey();
    const encrypted = await Promise.all(
      values.map(
        async ([name, value]) =>
          [name, await encrypt(key, value, app.id, name)] as const,
      ),
    );
    store.transaction(() => {
      for (const [name, value] of encrypted)
        store.setConfig(app.id, name, value);
    });
    print(`saved; the next push or \`hoist restart ${app.name}\` picks it up`);
  } else if (verb === "config:unset") {
    if (rest.length !== 1) throw new Error("Usage: hoist config:unset <app> K");
    store.unsetConfig(app.id, configKey(rest[0] ?? ""));
    print("saved; the next push or restart picks it up");
  } else {
    if (
      new Set(rest).size !== rest.length ||
      rest.some((flag) => !["--json", "--reveal"].includes(flag))
    )
      throw new Error("Usage: hoist config:list <app> [--json] [--reveal]");
    const entries = Object.entries(store.config(app.id));
    const key =
      rest.includes("--reveal") && entries.length
        ? await store.secretKey()
        : undefined;
    const values = await Promise.all(
      entries.map(async ([name, ciphertext]) => {
        if (!key) return { key: name, value: "••••" };
        const value = await decrypt(key, ciphertext, app.id, name);
        return { key: name, value, length: Buffer.byteLength(value) };
      }),
    );
    print(
      rest.includes("--json")
        ? JSON.stringify(values)
        : values
            .map(
              (row) =>
                `${row.key}=${row.value}${row.length === undefined ? "" : ` (${row.length} bytes)`}`,
            )
            .join("\n"),
    );
  }
}
