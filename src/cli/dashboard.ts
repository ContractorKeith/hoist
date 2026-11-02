import { createInterface } from "node:readline/promises";
import { DashboardStore } from "../store/dashboard";
import type { SqliteStore } from "../store/sqlite";
import { hashPassword } from "../web/auth";

export async function dashboardPassword(
  _root: string,
  store: SqliteStore,
  args: string[],
): Promise<void> {
  if (args.length !== 1) throw new Error("Usage: hoist dashboard:set-password");
  let password: string;
  if (process.stdin.isTTY) {
    // Mute echoed input while readline retains editing and signal handling.
    const output = new (await import("node:stream")).Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const reader = createInterface({
      input: process.stdin,
      output,
      terminal: true,
    });
    process.stderr.write("Owner password: ");
    try {
      password = await reader.question("");
    } finally {
      reader.close();
      process.stderr.write("\n");
    }
  } else {
    const input = await Bun.stdin.text();
    password = input.replace(/\r?\n$/, "");
  }
  if (!password || password.length > 1024 || /[\r\n\0]/.test(password))
    throw new Error("Password must be 1–1024 characters on one line");
  new DashboardStore(store.db).savePassword(await hashPassword(password));
  console.log("Dashboard password saved");
}
